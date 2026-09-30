// 用户域：个人资料与收货地址。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  ok,
  optionalText,
  parseBody,
  requireValue,
} = require("../http");
const { publicUser } = require("../views");

module.exports = async function handleUser(req, res, url, ctx) {
  const { method, pathname, identity, pickText, acceptorGate } = ctx;

  if (method === "GET" && pathname === "/api/user/profile") {
    const user = get("SELECT * FROM users WHERE id = ?", [identity.id]);
    const stats = {
      published: get("SELECT COUNT(*) AS total FROM tasks WHERE publisher_id = ?", [identity.id]).total,
      accepted: get("SELECT COUNT(*) AS total FROM orders WHERE acceptor_id = ?", [identity.id]).total,
      completed: get(
        `SELECT COUNT(*) AS total FROM orders
         WHERE (publisher_id = ? OR acceptor_id = ?) AND status = 3`,
        [identity.id, identity.id],
      ).total,
      unread: get(
        "SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND is_read = 0",
        [identity.id],
      ).total,
    };
    // 剥离 openid 后返回（原审计问题 #5：此前直接返回 SELECT * 整行）
    // 同时带上接单资格摘要，个人中心据此展示"已认证 / 去认证"入口
    const gate = acceptorGate(identity.id);
    ok(res, { ...publicUser(user), stats, acceptor: gate.summary });
    return true;
  }

  if (method === "PUT" && pathname === "/api/user/profile") {
    const body = await parseBody(req);
    const nickname = pickText(body.nickname, 32);
    if (nickname !== null) requireValue(nickname.length > 0, "昵称不能为空");
    run(
      `UPDATE users SET nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url),
        phone = COALESCE(?, phone), community = COALESCE(?, community),
        building = COALESCE(?, building), room = COALESCE(?, room), updated_at = ?
       WHERE id = ?`,
      [
        nickname,
        pickText(body.avatarUrl, 255),
        pickText(body.phone, 20),
        pickText(body.community, 100),
        pickText(body.building, 32),
        pickText(body.room, 32),
        now(),
        identity.id,
      ],
    );
    ok(res, publicUser(get("SELECT * FROM users WHERE id = ?", [identity.id])), "资料已更新");
    return true;
  }

  if (method === "GET" && pathname === "/api/addresses") {
    ok(
      res,
      all("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", [identity.id]),
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/addresses") {
    const body = await parseBody(req);
    const contactName = optionalText(body.contactName, 32);
    const phone = optionalText(body.phone, 20);
    const community = optionalText(body.community, 100);
    requireValue(Boolean(contactName && phone && community), "请填写联系人、电话和社区");
    requireValue(/^[\d+\-() ]{6,20}$/.test(phone), "联系电话格式不正确");
    const result = transaction(() => {
      if (body.isDefault) {
        run("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [identity.id]);
      }
      return run(
        `INSERT INTO addresses
          (user_id, contact_name, phone, community, building, room, detail, is_default, address_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          identity.id,
          contactName,
          phone,
          community,
          optionalText(body.building, 32),
          optionalText(body.room, 32),
          optionalText(body.detail, 200),
          body.isDefault ? 1 : 0,
          Number(body.addressType) === 2 ? 2 : 1,
        ],
      );
    });
    ok(res, get("SELECT * FROM addresses WHERE id = ?", [result.lastInsertRowid]), "地址已新增");
    return true;
  }

  const addressMatch = pathname.match(/^\/api\/addresses\/(\d+)$/);
  if (method === "PUT" && addressMatch) {
    const body = await parseBody(req);
    const address = get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", [
      Number(addressMatch[1]),
      identity.id,
    ]);
    if (!address) throw new HttpError(404, "地址不存在");
    const contactName = pickText(body.contactName, 32) ?? address.contact_name;
    const phone = pickText(body.phone, 20) ?? address.phone;
    const community = pickText(body.community, 100) ?? address.community;
    requireValue(Boolean(contactName && phone && community), "请填写联系人、电话和社区");
    requireValue(/^[\d+\-() ]{6,20}$/.test(phone), "联系电话格式不正确");
    transaction(() => {
      if (body.isDefault) {
        run("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [identity.id]);
      }
      run(
        `UPDATE addresses SET contact_name = ?, phone = ?, community = ?, building = ?,
          room = ?, detail = ?, is_default = ?, address_type = ? WHERE id = ?`,
        [
          contactName,
          phone,
          community,
          pickText(body.building, 32) ?? address.building,
          pickText(body.room, 32) ?? address.room,
          pickText(body.detail, 200) ?? address.detail,
          body.isDefault === undefined ? address.is_default : body.isDefault ? 1 : 0,
          body.addressType === undefined ? address.address_type : Number(body.addressType) === 2 ? 2 : 1,
          address.id,
        ],
      );
    });
    ok(res, null, "地址已更新");
    return true;
  }

  if (method === "DELETE" && addressMatch) {
    const result = run("DELETE FROM addresses WHERE id = ? AND user_id = ?", [
      Number(addressMatch[1]),
      identity.id,
    ]);
    if (!result.changes) throw new HttpError(404, "地址不存在");
    ok(res, null, "地址已删除");
    return true;
  }

  return false;
};
