// 订单域：订单列表/详情、开始服务、提交完成、确认结算、取消、评价。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  ok,
  optionalText,
  parseBody,
  readPagination,
  requireValue,
} = require("../http");
const { ORDER_STATUS, PAY_STATUS, TASK_STATUS } = require("../status");
const { orderView } = require("../views");

module.exports = async function handleOrders(req, res, url, ctx) {
  const {
    method,
    pathname,
    identity,
    ensureOrder,
    canViewOrder,
    createMessage,
    changeBalance,
    logOperation,
    serviceFeeRate,
    MAX_CREDIT_SCORE,
  } = ctx;

  if (method === "GET" && pathname === "/api/orders") {
    const role = url.searchParams.get("role") || "published";
    const status = url.searchParams.get("status");
    const where = [role === "accepted" ? "o.acceptor_id = ?" : "o.publisher_id = ?"];
    const params = [identity.id];
    if (status !== null && status !== "") {
      where.push("o.status = ?");
      params.push(Number(status));
    }
    const { page, pageSize } = readPagination(url);
    const total = get(
      `SELECT COUNT(*) AS total FROM orders o WHERE ${where.join(" AND ")}`,
      params,
    ).total;
    // 评价数与当前用户是否已评用相关子查询一次取出，避免逐单 N+1 查询
    const rows = all(
      `SELECT o.*, t.title, t.pickup_address, t.delivery_address, t.expect_time,
        t.images AS task_images, t.completion_images, t.status AS task_status,
        c.name AS category_name, c.icon AS category_icon, c.address_mode AS category_address_mode,
        pu.nickname AS publisher_name, ac.nickname AS acceptor_name,
        (SELECT COUNT(*) FROM reviews r WHERE r.order_id = o.id) AS review_count,
        EXISTS(SELECT 1 FROM reviews r WHERE r.order_id = o.id AND r.reviewer_id = ?) AS reviewed
       FROM orders o
       JOIN tasks t ON t.id = o.task_id
       JOIN categories c ON c.id = t.category_id
       JOIN users pu ON pu.id = o.publisher_id
       JOIN users ac ON ac.id = o.acceptor_id
       WHERE ${where.join(" AND ")}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [identity.id, ...params, pageSize, (page - 1) * pageSize],
    );
    const list = rows.map((row) => ({
      ...orderView(row),
      reviewed: Boolean(row.reviewed),
      review_count: Number(row.review_count || 0),
    }));
    ok(res, { list, total, page, pageSize });
    return true;
  }

  const orderMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
  if (method === "GET" && orderMatch) {
    const order = ensureOrder(Number(orderMatch[1]));
    if (!canViewOrder(order, identity)) throw new HttpError(403, "无权查看该订单");
    ok(res, {
      ...orderView(order),
      reviews: all(
        `SELECT r.*, u.nickname AS reviewer_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.order_id = ? ORDER BY r.id`,
        [order.id],
      ),
      complaint: get(
        "SELECT * FROM complaints WHERE order_id = ? ORDER BY id DESC LIMIT 1",
        [order.id],
      ),
    });
    return true;
  }

  const startMatch = pathname.match(/^\/api\/orders\/(\d+)\/start$/);
  if (method === "POST" && startMatch) {
    const order = ensureOrder(Number(startMatch[1]));
    if (order.acceptor_id !== Number(identity.id)) throw new HttpError(403, "只有接单者可以开始服务");
    if (Number(order.status) === ORDER_STATUS.DISPUTED) {
      throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    }
    if (Number(order.status) !== ORDER_STATUS.ACCEPTED) {
      throw new HttpError(409, "当前订单不能开始服务");
    }
    transaction(() => {
      run("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", [
        ORDER_STATUS.IN_SERVICE,
        now(),
        order.id,
      ]);
      run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
        TASK_STATUS.IN_SERVICE,
        now(),
        order.task_id,
      ]);
      createMessage(order.publisher_id, "订单已开始", `“${order.title}”已开始服务。`, 3, order.id);
    });
    logOperation(identity, "start_order", "order", order.id, "", req);
    ok(res, orderView(ensureOrder(order.id)), "已开始服务");
    return true;
  }

  const finishMatch = pathname.match(/^\/api\/orders\/(\d+)\/finish$/);
  if (method === "POST" && finishMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(finishMatch[1]));
    if (order.acceptor_id !== Number(identity.id)) throw new HttpError(403, "只有接单者可以提交完成");
    if (Number(order.status) === ORDER_STATUS.DISPUTED) {
      throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    }
    if (Number(order.status) !== ORDER_STATUS.IN_SERVICE) {
      throw new HttpError(409, "订单当前不可提交完成");
    }
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    requireValue(images.length, "请至少上传一张完成凭证");
    transaction(() => {
      // 说明（原审计问题 #29）：此处原有 "UPDATE orders SET status = 2" 是空操作——
      // 进入本分支时订单状态本来就是 2（服务中），而"待确认"这一进度只记录在
      // tasks.status = 3 上。为避免误导，改为只刷新 updated_at，
      // 进度状态统一由任务表承载，订单表不再出现"看起来在改状态实际没改"的语句。
      run("UPDATE orders SET updated_at = ? WHERE id = ?", [now(), order.id]);
      run(
        `UPDATE tasks SET status = ?, finished_at = ?, completion_images = ?, updated_at = ?
         WHERE id = ?`,
        [TASK_STATUS.AWAITING_CONFIRM, now(), JSON.stringify(images), now(), order.task_id],
      );
      createMessage(
        order.publisher_id,
        "等待确认完成",
        `“${order.title}”已提交完成凭证，请及时确认。`,
        3,
        order.id,
      );
    });
    logOperation(identity, "finish_order", "order", order.id, `${images.length} 张凭证`, req);
    ok(res, orderView(ensureOrder(order.id)), "完成凭证已提交");
    return true;
  }

  const confirmMatch = pathname.match(/^\/api\/orders\/(\d+)\/confirm$/);
  if (method === "POST" && confirmMatch) {
    const order = ensureOrder(Number(confirmMatch[1]));
    if (order.publisher_id !== Number(identity.id)) throw new HttpError(403, "只有发布者可以确认完成");
    if (Number(order.status) === ORDER_STATUS.DISPUTED) {
      throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    }
    if (Number(order.task_status) !== TASK_STATUS.AWAITING_CONFIRM || Number(order.status) !== ORDER_STATUS.IN_SERVICE) {
      throw new HttpError(409, "订单当前不可确认");
    }
    transaction(() => {
      run("UPDATE orders SET status = ?, pay_status = ?, confirm_time = ?, updated_at = ? WHERE id = ?", [
        ORDER_STATUS.COMPLETED,
        PAY_STATUS.SETTLED,
        now(),
        now(),
        order.id,
      ]);
      run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
        TASK_STATUS.COMPLETED,
        now(),
        order.task_id,
      ]);
      // 结算报酬给接单者（含手续费扣除），余额变动与流水成对写入
      const income = Number((Number(order.amount) * (1 - serviceFeeRate)).toFixed(2));
      changeBalance(order.acceptor_id, income, order.id, 1, `订单“${order.title}”结算`);
      createMessage(order.acceptor_id, "订单已结算", `“${order.title}”已确认完成，报酬已到账。`, 3, order.id);
    });
    logOperation(identity, "confirm_order", "order", order.id, `¥${order.amount}`, req);
    ok(res, orderView(ensureOrder(order.id)), "订单已完成，报酬已结算");
    return true;
  }

  const cancelOrderMatch = pathname.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (method === "POST" && cancelOrderMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(cancelOrderMatch[1]));
    if (!canViewOrder(order, identity)) throw new HttpError(403, "无权操作该订单");
    if (Number(order.status) === ORDER_STATUS.DISPUTED) {
      throw new HttpError(409, "订单存在争议，需等待管理员处理结果");
    }
    // 接单者已提交完成凭证后，资金不能由单方取消退回，避免接单者白干；有异议走投诉
    if (Number(order.task_status) === TASK_STATUS.AWAITING_CONFIRM) {
      throw new HttpError(409, "对方已提交完成凭证，不能直接取消；如有异议请发起投诉");
    }
    if (![ORDER_STATUS.ACCEPTED, ORDER_STATUS.IN_SERVICE].includes(Number(order.status))) {
      throw new HttpError(409, "当前订单不可取消");
    }
    transaction(() => {
      run(
        "UPDATE orders SET status = ?, pay_status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?",
        [
          ORDER_STATUS.CANCELLED,
          PAY_STATUS.REFUNDED,
          optionalText(body.reason, 200) || "双方协商取消",
          now(),
          order.id,
        ],
      );
      run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
        TASK_STATUS.CANCELLED,
        now(),
        order.task_id,
      ]);
      // 托管款退回发布者（余额变动与流水成对写入）
      changeBalance(order.publisher_id, Number(order.amount), order.id, 3, `订单“${order.title}”取消退款`);
      createMessage(order.acceptor_id, "订单已取消", `“${order.title}”已取消。`, 3, order.id);
    });
    logOperation(identity, "cancel_order", "order", order.id, String(body.reason || ""), req);
    ok(res, orderView(ensureOrder(order.id)), "订单已取消");
    return true;
  }

  const reviewMatch = pathname.match(/^\/api\/orders\/(\d+)\/review$/);
  if (method === "POST" && reviewMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(reviewMatch[1]));
    if (!canViewOrder(order, identity) || identity.type === "admin") {
      throw new HttpError(403, "只有订单参与双方可以评价");
    }
    if (Number(order.status) !== ORDER_STATUS.COMPLETED) {
      throw new HttpError(409, "订单完成后才能评价");
    }
    const reviewerId = Number(identity.id);
    const revieweeId =
      reviewerId === Number(order.publisher_id) ? Number(order.acceptor_id) : Number(order.publisher_id);
    requireValue(Number(body.rating) >= 1 && Number(body.rating) <= 5, "评分需为 1-5 星");
    if (get("SELECT id FROM reviews WHERE order_id = ? AND reviewer_id = ?", [order.id, reviewerId])) {
      throw new HttpError(409, "你已经评价过该订单");
    }
    const result = run(
      `INSERT INTO reviews (order_id, reviewer_id, reviewee_id, rating, content, tags)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        reviewerId,
        revieweeId,
        Number(body.rating),
        String(body.content || "").slice(0, 500),
        Array.isArray(body.tags) ? body.tags.join(",") : String(body.tags || ""),
      ],
    );
    const avg = get("SELECT AVG(rating) AS avg_rating FROM reviews WHERE reviewee_id = ?", [
      revieweeId,
    ]).avg_rating;
    // 信用分上限放宽到 120（原审计问题 #24）：原先初始值即 100、上限也是 100，
    // 种子用户普遍在 95–100 分，收到好评 +1 后分数毫无变化，
    // "好评提升信用"这条正反馈实际失效；同时信用分此前也从不参与任何业务判断。
    const creditAdjust = Number(body.rating) >= 4 ? 1 : Number(body.rating) <= 2 ? -2 : 0;
    run(
      `UPDATE users SET credit_score = MAX(0, MIN(?, credit_score + ?)), updated_at = ?
       WHERE id = ?`,
      [MAX_CREDIT_SCORE, creditAdjust, now(), revieweeId],
    );
    createMessage(
      revieweeId,
      "收到新评价",
      `你收到一条 ${Number(body.rating)} 星评价，当前平均评分 ${Number(avg).toFixed(1)}。`,
      3,
      order.id,
    );
    ok(res, get("SELECT * FROM reviews WHERE id = ?", [result.lastInsertRowid]), "评价已提交");
    return true;
  }

  return false;
};
