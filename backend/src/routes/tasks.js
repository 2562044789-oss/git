// 任务域：任务大厅列表 / 发布 / 详情 / 接单 / 取消。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  enforceRateLimit,
  ok,
  optionalText,
  parseBody,
  readMoney,
  readPagination,
  requireValue,
} = require("../http");
const { ORDER_STATUS, PAY_STATUS, TASK_STATUS } = require("../status");
const { orderView, taskView } = require("../views");

module.exports = async function handleTasks(req, res, url, ctx) {
  const {
    method,
    pathname,
    identity,
    acceptorGate,
    assertAcceptorActive,
    buildTaskWhere,
    ensureTask,
    ensureOrder,
    createMessage,
    createOrderNumber,
    logOperation,
    MIN_CREDIT_TO_TRADE,
  } = ctx;

  if (method === "GET" && pathname === "/api/tasks") {
    const viewerId = identity?.type === "user" ? identity.id : null;
    const viewer = viewerId
      ? get("SELECT community FROM users WHERE id = ?", [viewerId])
      : null;
    const viewerCommunity = viewer?.community || "";
    // 任务列表里就带上接单资格：未认证的用户看到的是"去认证"引导，
    // 而不是点下接单按钮才收到 403
    const gate = viewerId ? acceptorGate(viewerId) : null;
    const acceptorArg = {
      canAccept: Boolean(gate?.canAccept),
      blockedReason: gate?.blockedReason || "",
    };
    const { where, params } = buildTaskWhere(url, viewerId);
    const sort = url.searchParams.get("sort");
    const sortMap = {
      reward: "t.reward DESC, t.created_at DESC",
      deadline: "t.expect_time ASC",
      // 就近优先：浏览者同社区任务排前，再按期望时间；未登录时退化为时间优先
      distance:
        "CASE WHEN (t.delivery_address LIKE ? OR t.pickup_address LIKE ?) THEN 0 ELSE 1 END, t.expect_time ASC",
      newest: "t.created_at DESC",
    };
    const orderBy = sortMap[sort] || sortMap.newest;
    const { page, pageSize } = readPagination(url);
    const orderParams = sort === "distance" ? [`%${viewerCommunity}%`, `%${viewerCommunity}%`] : [];
    const rows = all(
      `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.address_mode AS category_address_mode,
        u.nickname AS publisher_name, u.community AS publisher_community
       FROM tasks t
       JOIN categories c ON c.id = t.category_id
       JOIN users u ON u.id = t.publisher_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, ...orderParams, pageSize, (page - 1) * pageSize],
    );
    const total = get(
      `SELECT COUNT(*) AS total FROM tasks t WHERE ${where}`,
      params,
    ).total;
    ok(res, {
      list: rows.map((row) => taskView(row, viewerId, false, viewerCommunity, acceptorArg)),
      total,
      page,
      pageSize,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/tasks") {
    enforceRateLimit(req, "publish-task", 30);
    const userId = Number(identity.id);
    const body = await parseBody(req);
    requireValue(body.categoryId, "请选择服务分类");
    const title = optionalText(body.title, 60);
    requireValue(title.length >= 4, "任务标题至少 4 个字");
    // 金额强制两位小数（原审计问题 #18：1.005 这类金额此前会被直接接受并落库）
    const reward = readMoney(body.reward, { min: 1, max: 5000, label: "报酬金额" });
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    const result = transaction(() => {
      // 余额校验移入事务内（原审计问题 #15）：原实现先读余额、再开事务扣除，
      // 在多进程部署下存在 TOCTOU 竞态，两个并发请求可同时通过校验造成透支
      const publisher = get("SELECT * FROM users WHERE id = ?", [userId]);
      requireValue(publisher && Number(publisher.status) === 1, "账号不存在或已被禁用");
      // 信用分真正参与业务判断（原审计问题 #24：此前该字段从不影响任何操作）
      requireValue(
        Number(publisher.credit_score ?? 100) >= MIN_CREDIT_TO_TRADE,
        `信用分低于 ${MIN_CREDIT_TO_TRADE}，暂时无法发布任务`,
      );
      requireValue(Number(publisher.balance) >= reward, "余额不足，请先充值后再发布");
      const taskResult = run(
        `INSERT INTO tasks (
          publisher_id, category_id, title, description, pickup_address, delivery_address,
          contact_name, contact_phone, expect_time, reward, images, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          userId,
          Number(body.categoryId),
          title,
          optionalText(body.description, 500),
          optionalText(body.pickupAddress, 200),
          optionalText(body.deliveryAddress, 200),
          optionalText(body.contactName, 32) || publisher.nickname,
          optionalText(body.contactPhone, 20) || publisher.phone,
          optionalText(body.expectTime, 32) || null,
          reward,
          JSON.stringify(images),
        ],
      );
      const taskId = Number(taskResult.lastInsertRowid);
      const balance = Number((Number(publisher.balance) - reward).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), userId]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 2, ?, ?, ?)`,
        [userId, -reward, balance, `发布任务“${title}”托管`],
      );
      return taskId;
    });
    logOperation(identity, "publish_task", "task", result, `¥${reward}`, req);
    const publisher = get("SELECT community FROM users WHERE id = ?", [userId]);
    ok(
      res,
      taskView(ensureTask(result), userId, true, publisher?.community || ""),
      "任务已发布并完成费用托管",
    );
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (method === "GET" && taskMatch) {
    const id = Number(taskMatch[1]);
    const viewer = identity?.type === "user"
      ? get("SELECT community FROM users WHERE id = ?", [identity.id])
      : null;
    const gate = identity?.type === "user" ? acceptorGate(identity.id) : null;
    ok(
      res,
      taskView(ensureTask(id), identity?.id, false, viewer?.community || "", {
        canAccept: Boolean(gate?.canAccept),
        blockedReason: gate?.blockedReason || "",
      }),
    );
    return true;
  }

  const acceptMatch = pathname.match(/^\/api\/tasks\/(\d+)\/accept$/);
  if (method === "POST" && acceptMatch) {
    enforceRateLimit(req, "accept-task", 60);
    const taskId = Number(acceptMatch[1]);
    const acceptorId = Number(identity.id);
    const orderId = transaction(() => {
      const task = get("SELECT * FROM tasks WHERE id = ?", [taskId]);
      if (!task) throw new HttpError(404, "任务不存在");
      if (task.publisher_id === acceptorId) throw new HttpError(400, "不能接取自己发布的任务");
      // 接单员准入门槛：必须已完成实名认证并缴纳保证金。
      // 未认证的用户仍然可以发布任务，但只能发布、不能接单。
      assertAcceptorActive(acceptorId);
      // 信用分真正参与业务判断（原审计问题 #24）
      const acceptor = get("SELECT credit_score, status FROM users WHERE id = ?", [acceptorId]);
      requireValue(acceptor && Number(acceptor.status) === 1, "账号不存在或已被禁用");
      requireValue(
        Number(acceptor.credit_score ?? 100) >= MIN_CREDIT_TO_TRADE,
        `信用分低于 ${MIN_CREDIT_TO_TRADE}，暂时无法接单`,
      );
      if (Number(task.status) !== TASK_STATUS.PENDING) {
        throw new HttpError(409, "任务已被其他邻居接取");
      }
      const changed = run(
        `UPDATE tasks SET status = ?, acceptor_id = ?, accepted_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
        [TASK_STATUS.ACCEPTED, acceptorId, now(), now(), taskId, TASK_STATUS.PENDING],
      );
      if (Number(changed.changes) !== 1) throw new HttpError(409, "任务已被其他邻居接取");
      const orderNo = createOrderNumber();
      const orderResult = run(
        `INSERT INTO orders (
          order_no, task_id, publisher_id, acceptor_id, amount, status, pay_status, pay_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNo,
          taskId,
          task.publisher_id,
          acceptorId,
          task.reward,
          ORDER_STATUS.ACCEPTED,
          PAY_STATUS.ESCROW,
          now(),
        ],
      );
      createMessage(
        task.publisher_id,
        "任务已被接单",
        `${get("SELECT nickname FROM users WHERE id = ?", [acceptorId]).nickname}已接取“${task.title}”。`,
        2,
        taskId,
      );
      createMessage(
        acceptorId,
        "接单成功",
        `你已成功接取“${task.title}”，请按约定时间完成服务。`,
        2,
        taskId,
      );
      return Number(orderResult.lastInsertRowid);
    });
    logOperation(identity, "accept_task", "order", orderId, `task ${taskId}`, req);
    ok(res, orderView(ensureOrder(orderId)), "接单成功");
    return true;
  }

  const cancelTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/cancel$/);
  if (method === "POST" && cancelTaskMatch) {
    const taskId = Number(cancelTaskMatch[1]);
    const userId = Number(identity.id);
    const body = await parseBody(req);
    transaction(() => {
      const task = get("SELECT * FROM tasks WHERE id = ?", [taskId]);
      if (!task) throw new HttpError(404, "任务不存在");
      if (task.publisher_id !== userId) throw new HttpError(403, "只能取消自己发布的任务");
      if (![TASK_STATUS.PENDING, TASK_STATUS.ACCEPTED].includes(Number(task.status))) {
        throw new HttpError(409, "当前状态不能取消");
      }
      const user = get("SELECT balance FROM users WHERE id = ?", [userId]);
      const balance = Number((user.balance + task.reward).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), userId]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 3, ?, ?, ?)`,
        [userId, task.reward, balance, `取消任务“${task.title}”退款`],
      );
      run(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        [TASK_STATUS.CANCELLED, now(), taskId],
      );
      const order = get("SELECT * FROM orders WHERE task_id = ?", [taskId]);
      if (order) {
        run(
          "UPDATE orders SET status = ?, pay_status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?",
          [
            ORDER_STATUS.CANCELLED,
            PAY_STATUS.REFUNDED,
            optionalText(body.reason, 200) || "发布者取消",
            now(),
            order.id,
          ],
        );
        createMessage(order.acceptor_id, "订单已取消", `“${task.title}”已由发布者取消。`, 3, order.id);
      }
    });
    logOperation(identity, "cancel_task", "task", taskId, String(body.reason || "发布者取消"), req);
    ok(res, null, "任务已取消，托管费用已退回");
    return true;
  }

  return false;
};
