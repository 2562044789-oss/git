// 消息域：站内消息列表与已读。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, run } = require("../db");
const { ok, readPagination } = require("../http");

module.exports = async function handleMessages(req, res, url, ctx) {
  const { method, pathname, identity } = ctx;

  if (method === "GET" && pathname === "/api/messages") {
    const type = url.searchParams.get("type");
    const { page, pageSize } = readPagination(url);
    const params = [identity.id];
    let where = "user_id = ?";
    if (type) {
      where += " AND type = ?";
      params.push(Number(type));
    }
    // 仍返回数组（预览页与既有调用方零改动），分页通过 LIMIT/OFFSET 截取；
    // 小程序端以"本批返回条数 < pageSize"判断是否还有下一页。
    params.push(pageSize, (page - 1) * pageSize);
    ok(
      res,
      all(
        `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params,
      ),
    );
    return true;
  }

  const readMessageMatch = pathname.match(/^\/api\/messages\/(\d+)\/read$/);
  if (method === "POST" && readMessageMatch) {
    run("UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?", [
      Number(readMessageMatch[1]),
      identity.id,
    ]);
    ok(res, null, "消息已读");
    return true;
  }

  if (method === "POST" && pathname === "/api/messages/read-all") {
    run("UPDATE messages SET is_read = 1 WHERE user_id = ?", [identity.id]);
    ok(res, null, "全部消息已读");
    return true;
  }

  return false;
};
