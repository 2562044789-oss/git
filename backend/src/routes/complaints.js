// 投诉域：查询/提交投诉（用户侧）。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  ok,
  optionalText,
  parseBody,
  requireValue,
} = require("../http");
const { ORDER_STATUS, PAY_STATUS, TASK_STATUS } = require("../status");

module.exports = async function handleComplaints(req, res, url, ctx) {
  const { method, pathname, identity, ensureOrder, canViewOrder, createMessage, logOperation } = ctx;

  if (method === "GET" && pathname === "/api/complaints") {
    ok(
      res,
      all(
        `SELECT c.*, t.title AS task_title, o.order_no
         FROM complaints c
         JOIN orders o ON o.id = c.order_id
         JOIN tasks t ON t.id = o.task_id
         WHERE c.complainant_id = ? OR c.respondent_id = ?
         ORDER BY c.created_at DESC`,
        [identity.id, identity.id],
      ),
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/complaints") {
    const body = await parseBody(req);
    const order = ensureOrder(Number(body.orderId));
    if (!canViewOrder(order, identity) || identity.type === "admin") {
      throw new HttpError(403, "只有订单参与双方可以投诉");
    }
    requireValue(body.reason, "请选择投诉原因");
    if (Number(order.status) === ORDER_STATUS.DISPUTED) {
      throw new HttpError(409, "该订单已在争议处理中，请勿重复投诉");
    }
    // 补充拦截（原审计问题 #13）：已完成订单发起投诉时不会冻结订单（status 保持 3），
    // 而原先"请勿重复投诉"的判断只认 status === 5，对已完成订单完全失效，
    // 导致同一订单可被反复投诉。现在按"是否已有未处理的投诉"判断，
    // 与订单是否被冻结无关。
    if (get("SELECT id FROM complaints WHERE order_id = ? AND status IN (0, 1) LIMIT 1", [order.id])) {
      throw new HttpError(409, "该订单已有待处理的投诉，请勿重复提交");
    }
    if (Number(order.pay_status) === PAY_STATUS.REFUNDED) {
      throw new HttpError(409, "该订单已完成退款，不能再发起投诉");
    }
    const respondentId =
      Number(identity.id) === Number(order.publisher_id) ? order.acceptor_id : order.publisher_id;
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    transaction(() => {
      const result = run(
        `INSERT INTO complaints
          (order_id, complainant_id, respondent_id, reason, description, images)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          identity.id,
          respondentId,
          optionalText(body.reason, 64),
          optionalText(body.description, 500),
          JSON.stringify(images),
        ],
      );
      run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
        TASK_STATUS.DISPUTED,
        now(),
        order.task_id,
      ]);
      // 资金尚未结算（进行中/待确认）时冻结订单，裁决前任何一方都不能推进或取消；
      // 已完成订单资金早已结算给接单者，不做冻结（裁决时按"已结算"分支处理）
      if ([ORDER_STATUS.ACCEPTED, ORDER_STATUS.IN_SERVICE].includes(Number(order.status))) {
        run(
          "UPDATE orders SET frozen_status = status, status = ?, updated_at = ? WHERE id = ?",
          [ORDER_STATUS.DISPUTED, now(), order.id],
        );
      }
      createMessage(respondentId, "收到订单投诉", `订单“${order.title}”已发起投诉，等待管理员处理。`, 4, order.id);
      logOperation(identity, "submit_complaint", "complaint", Number(result.lastInsertRowid), String(body.reason), req);
    });
    const latest = get("SELECT * FROM complaints WHERE order_id = ? ORDER BY id DESC LIMIT 1", [order.id]);
    ok(res, latest, "投诉已提交");
    return true;
  }

  return false;
};
