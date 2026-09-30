// 管理域：仪表盘 / 用户 / 任务 / 订单 / 分类 / 投诉裁决 / 接单员审核 / 日志 / 公告。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
// 进入本域前 identity 已经过 handleApi 统一鉴权（adminOnly），
// 破坏性操作再由 requireSuperAdmin 二次把关。
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  ok,
  optionalText,
  parseBody,
  readPagination,
  requireValue,
} = require("../http");
const {
  ACCEPTOR_STATUS,
  COMPLAINT_STATUS,
  DEPOSIT_STATUS,
  ORDER_STATUS,
  PAY_STATUS,
  TASK_STATUS,
  deriveTaskStatus,
} = require("../status");
const { acceptorView, maskIdCard, publicAdminUser, taskView } = require("../views");

module.exports = async function handleAdmin(req, res, url, ctx) {
  const {
    method,
    pathname,
    identity,
    requireSuperAdmin,
    assertAssignableTaskStatus,
    readFundState,
    changeBalance,
    createMessage,
    logOperation,
    serviceFeeRate,
    ACCEPTOR_DEPOSIT_AMOUNT,
  } = ctx;

  if (method === "GET" && pathname === "/api/admin/dashboard") {
    const userCount = get("SELECT COUNT(*) AS total FROM users").total;
    const taskCount = get("SELECT COUNT(*) AS total FROM tasks").total;
    const orderCount = get("SELECT COUNT(*) AS total FROM orders").total;
    const transactionAmount = get(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = 3",
    ).total;
    const pendingComplaints = get("SELECT COUNT(*) AS total FROM complaints WHERE status IN (0, 1)").total;
    // 接单员认证指标：已认证人数与待审核申请数
    const acceptorCount = get(
      "SELECT COUNT(*) AS total FROM acceptor_profiles WHERE status = ? AND deposit_status = ?",
      [ACCEPTOR_STATUS.ACTIVE, DEPOSIT_STATUS.HELD],
    ).total;
    const pendingAcceptorReviews = get(
      "SELECT COUNT(*) AS total FROM acceptor_profiles WHERE status = ?",
      [ACCEPTOR_STATUS.REVIEWING],
    ).total;
    const statusDistribution = all(
      "SELECT status, COUNT(*) AS total FROM tasks GROUP BY status ORDER BY status",
    );
    const recentOrders = all(
      `SELECT o.id, o.order_no, o.amount, o.status, o.created_at, t.title,
        pu.nickname AS publisher_name, ac.nickname AS acceptor_name
       FROM orders o
       JOIN tasks t ON t.id = o.task_id
       JOIN users pu ON pu.id = o.publisher_id
       JOIN users ac ON ac.id = o.acceptor_id
       ORDER BY o.created_at DESC LIMIT 8`,
    );
    ok(res, {
      metrics: {
        userCount,
        taskCount,
        orderCount,
        transactionAmount,
        pendingComplaints,
        acceptorCount,
        pendingAcceptorReviews,
      },
      statusDistribution,
      recentOrders,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/users") {
    requireSuperAdmin(identity);
    const keyword = optionalText(url.searchParams.get("keyword"), 64);
    const { page, pageSize } = readPagination(url);
    const like = `%${keyword}%`;
    // 用相关子查询统计，避免 GROUP BY u.* 在 MySQL ONLY_FULL_GROUP_BY 下报错
    const total = get(
      `SELECT COUNT(*) AS total FROM users u
       WHERE u.nickname LIKE ? OR u.uid LIKE ? OR u.phone LIKE ? OR u.community LIKE ?`,
      [like, like, like, like],
    ).total;
    const list = all(
      `SELECT u.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.publisher_id = u.id) AS published_count,
        (SELECT COUNT(*) FROM orders o WHERE o.acceptor_id = u.id) AS accepted_count
       FROM users u
       WHERE u.nickname LIKE ? OR u.uid LIKE ? OR u.phone LIKE ? OR u.community LIKE ?
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`,
      [like, like, like, like, pageSize, (page - 1) * pageSize],
    ).map(publicAdminUser);
    // 分页 + 剥离 openid（原审计问题 #4：此前一次返回全表且包含明文 openid）
    ok(res, { list, total, page, pageSize });
    return true;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
  if (method === "PUT" && adminUserMatch) {
    requireSuperAdmin(identity);
    const body = await parseBody(req);
    const targetId = Number(adminUserMatch[1]);
    if (!get("SELECT id FROM users WHERE id = ?", [targetId])) {
      throw new HttpError(404, "用户不存在");
    }
    run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", [
      body.status ? 1 : 0,
      now(),
      targetId,
    ]);
    logOperation(identity, "set_user_status", "user", targetId, body.status ? "启用" : "禁用", req);
    ok(res, null, "用户状态已更新");
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/tasks") {
    const keyword = url.searchParams.get("keyword") || "";
    ok(
      res,
      all(
        `SELECT t.*, c.name AS category_name, u.nickname AS publisher_name,
          a.nickname AS acceptor_name
         FROM tasks t
         JOIN categories c ON c.id = t.category_id
         JOIN users u ON u.id = t.publisher_id
         LEFT JOIN users a ON a.id = t.acceptor_id
         WHERE t.title LIKE ? OR u.nickname LIKE ?
         ORDER BY t.id DESC`,
        [`%${keyword}%`, `%${keyword}%`],
      ).map((row) => taskView(row, null, true)),
    );
    return true;
  }

  const adminTaskMatch = pathname.match(/^\/api\/admin\/tasks\/(\d+)\/status$/);
  if (method === "PUT" && adminTaskMatch) {
    requireSuperAdmin(identity);
    const body = await parseBody(req);
    const targetId = Number(adminTaskMatch[1]);
    const status = Number(body.status);
    if (!get("SELECT id FROM tasks WHERE id = ?", [targetId])) {
      throw new HttpError(404, "任务不存在");
    }
    // 枚举校验 + 资金流程保护（原审计问题 #14）：此前状态值原样落库，
    // 既可以是任意数字，也可以把任务直接改成"已完成"，
    // 从而绕过资金结算流程，出现"任务已完成但钱仍托管中"的账实不符。
    assertAssignableTaskStatus(status, targetId);
    run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [status, now(), targetId]);
    logOperation(identity, "set_task_status", "task", targetId, `状态 ${status}`, req);
    ok(res, null, "任务状态已更新");
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/orders") {
    const status = url.searchParams.get("status");
    const params = [];
    let where = "1 = 1";
    if (status !== null && status !== "") {
      where += " AND o.status = ?";
      params.push(Number(status));
    }
    ok(
      res,
      all(
        `SELECT o.*, t.title, c.name AS category_name,
          pu.nickname AS publisher_name, ac.nickname AS acceptor_name
         FROM orders o
         JOIN tasks t ON t.id = o.task_id
         JOIN categories c ON c.id = t.category_id
         JOIN users pu ON pu.id = o.publisher_id
         JOIN users ac ON ac.id = o.acceptor_id
         WHERE ${where}
         ORDER BY o.id DESC`,
        params,
      ),
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/categories") {
    ok(res, all("SELECT * FROM categories ORDER BY sort, id"));
    return true;
  }

  if (method === "POST" && pathname === "/api/admin/categories") {
    const body = await parseBody(req);
    requireValue(body.name, "分类名称不能为空");
    const result = run(
      "INSERT INTO categories (name, icon, color, sort, status) VALUES (?, ?, ?, ?, ?)",
      [
        String(body.name),
        body.icon || "dot",
        body.color || "#6DBF8A",
        Number(body.sort || 99),
        body.status === 0 ? 0 : 1,
      ],
    );
    ok(res, get("SELECT * FROM categories WHERE id = ?", [result.lastInsertRowid]), "分类已新增");
    return true;
  }

  const adminCategoryMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (method === "PUT" && adminCategoryMatch) {
    const body = await parseBody(req);
    run(
      `UPDATE categories SET name = ?, icon = ?, color = ?, sort = ?, status = ? WHERE id = ?`,
      [
        String(body.name || ""),
        body.icon || "dot",
        body.color || "#6DBF8A",
        Number(body.sort || 99),
        body.status === 0 ? 0 : 1,
        Number(adminCategoryMatch[1]),
      ],
    );
    ok(res, null, "分类已更新");
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/complaints") {
    ok(
      res,
      all(
        `SELECT c.*, o.order_no, o.status AS order_status, o.frozen_status,
          o.amount AS order_amount, t.title AS task_title,
          cu.nickname AS complainant_name, ru.nickname AS respondent_name
         FROM complaints c
         JOIN orders o ON o.id = c.order_id
         JOIN tasks t ON t.id = o.task_id
         JOIN users cu ON cu.id = c.complainant_id
         JOIN users ru ON ru.id = c.respondent_id
         ORDER BY c.id DESC`,
      ),
    );
    return true;
  }

  const adminComplaintMatch = pathname.match(/^\/api\/admin\/complaints\/(\d+)$/);
  if (method === "PUT" && adminComplaintMatch) {
    requireSuperAdmin(identity);
    const body = await parseBody(req);
    const complaint = get("SELECT * FROM complaints WHERE id = ?", [Number(adminComplaintMatch[1])]);
    if (!complaint) throw new HttpError(404, "投诉记录不存在");
    const verdict = optionalText(body.verdict, 16); // refund 退款给发布者 / pay 结算给接单者 / reject 驳回
    requireValue(["", "refund", "pay", "reject"].includes(verdict), "裁决结论不合法");
    const handleResult = optionalText(body.handleResult, 500);
    const finalStatus = Number(
      body.status ??
        (verdict === "reject" ? COMPLAINT_STATUS.REJECTED : COMPLAINT_STATUS.RESOLVED),
    );
    transaction(() => {
      run("UPDATE complaints SET status = ?, handle_result = ?, handled_at = ? WHERE id = ?", [
        finalStatus,
        handleResult,
        now(),
        complaint.id,
      ]);
      const order = get("SELECT * FROM orders WHERE id = ?", [complaint.order_id]);
      if (order && verdict) {
        const task = get("SELECT * FROM tasks WHERE id = ?", [order.task_id]);
        const orderTitle = task?.title || "";
        // 不再用 status 猜"钱在不在托管中"，直接看支付状态这一唯一事实
        const fundState = readFundState(order);
        if (verdict === "refund") {
          if (fundState === "escrow") {
            // 服务未完成：托管款原路退回发布者
            changeBalance(order.publisher_id, Number(order.amount), order.id, 3, `投诉裁决退款“${orderTitle}”`);
          } else if (fundState === "settled") {
            // 已完成订单：报酬早已结算给接单者，因此必须先把已结算金额扣回，再退给发布者。
            // 原实现直接跳过资金操作，导致"订单显示已退款、双方余额都没动"。
            const income = Number((Number(order.amount) * (1 - serviceFeeRate)).toFixed(2));
            changeBalance(order.acceptor_id, -income, order.id, 2, `投诉裁决扣回“${orderTitle}”`);
            changeBalance(order.publisher_id, Number(order.amount), order.id, 3, `投诉裁决退款“${orderTitle}”`);
          }
          // fundState === "refunded"：此前已退过款，保持幂等，不重复动账
          run(
            "UPDATE orders SET status = ?, pay_status = ?, frozen_status = NULL, cancel_reason = ?, updated_at = ? WHERE id = ?",
            [ORDER_STATUS.CANCELLED, PAY_STATUS.REFUNDED, "投诉裁决退款", now(), order.id],
          );
          run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
            TASK_STATUS.CANCELLED,
            now(),
            order.task_id,
          ]);
        } else if (verdict === "pay") {
          if (fundState === "refunded") {
            throw new HttpError(409, "该订单资金已退回发布者，不能再裁决结算给接单者");
          }
          if (fundState === "escrow") {
            // 认定服务完成：托管款结算给接单者（已结算过则跳过，保持幂等）
            const income = Number((Number(order.amount) * (1 - serviceFeeRate)).toFixed(2));
            changeBalance(order.acceptor_id, income, order.id, 1, `投诉裁决结算“${orderTitle}”`);
          }
          run(
            "UPDATE orders SET status = ?, pay_status = ?, confirm_time = ?, frozen_status = NULL, updated_at = ? WHERE id = ?",
            [ORDER_STATUS.COMPLETED, PAY_STATUS.SETTLED, now(), order.id],
          );
          run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
            TASK_STATUS.COMPLETED,
            now(),
            order.task_id,
          ]);
        } else if (verdict === "reject") {
          // 驳回：先把订单恢复到冻结前的状态（若确实冻结过），
          // 再依据订单与任务的事实推导任务进度。
          //
          // 修复背景（原审计问题 #12）：原实现把恢复逻辑整体包在
          // if (order.frozen_status != null) 里，而"已完成订单被投诉"时订单从未被冻结
          // （frozen_status 为 null），于是什么都不恢复——任务被投诉改成 6（争议中）后
          // 永久卡死，与订单已完成的状态长期不一致。现在恢复逻辑不再依赖 frozen_status。
          if (order.frozen_status != null) {
            run(
              "UPDATE orders SET status = frozen_status, frozen_status = NULL, updated_at = ? WHERE id = ?",
              [now(), order.id],
            );
          }
          const restoredOrder = get("SELECT * FROM orders WHERE id = ?", [order.id]);
          run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
            deriveTaskStatus(restoredOrder, task),
            now(),
            order.task_id,
          ]);
        }
        const verdictText = { refund: "已裁决退款给发布者", pay: "已裁决结算给接单者", reject: "投诉已驳回" }[verdict];
        createMessage(complaint.complainant_id, "投诉处理结果", `${verdictText}。${handleResult}`, 4, order.id);
        createMessage(complaint.respondent_id, "投诉处理结果", `${verdictText}。${handleResult}`, 4, order.id);
      } else {
        createMessage(
          complaint.complainant_id,
          "投诉处理结果",
          handleResult || "管理员已完成处理。",
          4,
          complaint.id,
        );
        createMessage(
          complaint.respondent_id,
          "投诉处理结果",
          handleResult || "管理员已完成处理。",
          4,
          complaint.id,
        );
      }
      logOperation(
        identity,
        "handle_complaint",
        "complaint",
        complaint.id,
        `${verdict || "note"} ${handleResult}`,
        req,
      );
    });
    ok(res, null, "投诉已处理");
    return true;
  }

  // ------------------------------------------------------------ 接单员审核

  if (method === "GET" && pathname === "/api/admin/acceptor-profiles") {
    requireSuperAdmin(identity);
    const { page, pageSize } = readPagination(url);
    const keyword = optionalText(url.searchParams.get("keyword"), 64);
    const statusRaw = url.searchParams.get("status");
    const where = [];
    const params = [];
    if (statusRaw !== null && statusRaw !== "" && Number.isInteger(Number(statusRaw))) {
      where.push("ap.status = ?");
      params.push(Number(statusRaw));
    }
    if (keyword) {
      where.push("(ap.real_name LIKE ? OR ap.phone LIKE ? OR u.nickname LIKE ? OR u.uid LIKE ?)");
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = get(
      `SELECT COUNT(*) AS total FROM acceptor_profiles ap JOIN users u ON u.id = ap.user_id ${clause}`,
      params,
    ).total;
    const rows = all(
      `SELECT ap.*, u.nickname, u.uid, u.balance, u.credit_score, a.username AS reviewer_name
       FROM acceptor_profiles ap
       JOIN users u ON u.id = ap.user_id
       LEFT JOIN admins a ON a.id = ap.reviewed_by
       ${clause}
       ORDER BY CASE ap.status WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 2 END, ap.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    // acceptorView 刻意不包含完整身份证号，只给出脱敏形式
    const list = rows.map((row) => ({
      ...acceptorView(row),
      nickname: row.nickname,
      uid: row.uid,
      balance: row.balance,
      credit_score: row.credit_score,
      reviewer_name: row.reviewer_name,
    }));
    const summary = {
      reviewing: get(
        "SELECT COUNT(*) AS total FROM acceptor_profiles WHERE status = ?",
        [ACCEPTOR_STATUS.REVIEWING],
      ).total,
      approved: get(
        "SELECT COUNT(*) AS total FROM acceptor_profiles WHERE status = ?",
        [ACCEPTOR_STATUS.APPROVED],
      ).total,
      active: get(
        "SELECT COUNT(*) AS total FROM acceptor_profiles WHERE status = ?",
        [ACCEPTOR_STATUS.ACTIVE],
      ).total,
      required_deposit: ACCEPTOR_DEPOSIT_AMOUNT,
    };
    ok(res, { list, total, page, pageSize, summary });
    return true;
  }

  // 查看完整身份证号：单独的接口 + 审计日志。
  // 完整号码属于敏感个人信息，不做常规列表字段，
  // 每次查看都会在操作日志里留痕，便于事后追责。
  const adminAcceptorIdCardMatch = pathname.match(
    /^\/api\/admin\/acceptor-profiles\/(\d+)\/id-card$/,
  );
  if (method === "GET" && adminAcceptorIdCardMatch) {
    requireSuperAdmin(identity);
    const profile = get("SELECT * FROM acceptor_profiles WHERE id = ?", [
      Number(adminAcceptorIdCardMatch[1]),
    ]);
    if (!profile) throw new HttpError(404, "认证申请不存在");
    logOperation(
      identity,
      "view_id_card",
      "acceptor",
      profile.id,
      `查看用户 ${profile.user_id} 的完整身份证号`,
      req,
    );
    ok(
      res,
      {
        id_card_no: profile.id_card_no,
        id_card_masked: maskIdCard(profile.id_card_no),
      },
      "已记录本次查看行为",
    );
    return true;
  }

  const adminAcceptorReviewMatch = pathname.match(
    /^\/api\/admin\/acceptor-profiles\/(\d+)\/review$/,
  );
  if (method === "PUT" && adminAcceptorReviewMatch) {
    requireSuperAdmin(identity);
    const body = await parseBody(req);
    const profile = get("SELECT * FROM acceptor_profiles WHERE id = ?", [
      Number(adminAcceptorReviewMatch[1]),
    ]);
    if (!profile) throw new HttpError(404, "认证申请不存在");
    if (Number(profile.status) !== ACCEPTOR_STATUS.REVIEWING) {
      throw new HttpError(409, "该申请当前不处于待审核状态，请刷新后重试");
    }
    const approved = body.approved === true || Number(body.approved) === 1;
    const reviewNote = optionalText(body.reviewNote, 200);
    requireValue(approved || reviewNote, "驳回时必须填写审核意见，便于申请人修改资料");
    const deposit = Number(profile.deposit_amount || ACCEPTOR_DEPOSIT_AMOUNT);
    transaction(() => {
      run(
        `UPDATE acceptor_profiles SET
          status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          approved ? ACCEPTOR_STATUS.APPROVED : ACCEPTOR_STATUS.REJECTED,
          reviewNote,
          identity.id,
          now(),
          now(),
          profile.id,
        ],
      );
      createMessage(
        profile.user_id,
        approved ? "接单员认证已通过" : "接单员认证未通过",
        approved
          ? `实名认证已通过，缴纳 ¥${deposit.toFixed(2)} 保证金后即可开始接单。`
          : `未通过原因：${reviewNote}。请修改资料后重新提交。`,
        1,
      );
    });
    logOperation(
      identity,
      "review_acceptor",
      "acceptor",
      profile.id,
      approved ? "审核通过" : `审核驳回：${reviewNote}`,
      req,
    );
    ok(
      res,
      acceptorView(get("SELECT * FROM acceptor_profiles WHERE id = ?", [profile.id])),
      approved ? "已通过实名认证" : "已驳回认证申请",
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/logs") {
    const { page, pageSize } = readPagination(url, 30, 100);
    const total = get("SELECT COUNT(*) AS total FROM operation_logs").total;
    const list = all(
      `SELECT l.*,
        CASE WHEN l.operator_type = 2 THEN a.username ELSE u.nickname END AS operator_name
       FROM operation_logs l
       LEFT JOIN users u ON l.operator_type = 1 AND u.id = l.operator_id
       LEFT JOIN admins a ON l.operator_type = 2 AND a.id = l.operator_id
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize],
    );
    ok(res, { list, total, page, pageSize });
    return true;
  }

  if (method === "GET" && pathname === "/api/admin/announcements") {
    ok(res, all("SELECT * FROM announcements ORDER BY id DESC"));
    return true;
  }

  if (method === "POST" && pathname === "/api/admin/announcements") {
    const body = await parseBody(req);
    requireValue(body.title && body.content, "公告标题和内容不能为空");
    const result = run("INSERT INTO announcements (title, content, status) VALUES (?, ?, 1)", [
      String(body.title),
      String(body.content),
    ]);
    logOperation(
      identity,
      "publish_announcement",
      "announcement",
      result.lastInsertRowid,
      String(body.title),
      req,
    );
    ok(res, get("SELECT * FROM announcements WHERE id = ?", [result.lastInsertRowid]), "公告已发布");
    return true;
  }

  // 公告改 / 撤：补齐"只能发、发错没法收"的缺口。
  // 三种用途共用这个接口：
  //   1) 只传 title/content  → 改文案，状态不变；
  //   2) 只传 status        → 上架 / 下架（下架后前台列表与详情都会消失）；
  //   3) 都传               → 改文案顺便上下架。
  const adminAnnouncementMatch = pathname.match(/^\/api\/admin\/announcements\/(\d+)$/);
  if (method === "PUT" && adminAnnouncementMatch) {
    const id = Number(adminAnnouncementMatch[1]);
    const existing = get("SELECT * FROM announcements WHERE id = ?", [id]);
    if (!existing) throw new HttpError(404, "公告不存在");
    const body = await parseBody(req);
    // 未传的字段保持原值，避免"只想下架却把正文清空"。
    const title =
      body.title === undefined ? existing.title : optionalText(body.title, 60);
    const content =
      body.content === undefined ? existing.content : optionalText(body.content, 500);
    requireValue(title && content, "公告标题和内容不能为空");
    let status = Number(existing.status);
    if (body.status !== undefined) {
      const next = Number(body.status);
      requireValue(next === 0 || next === 1, "公告状态只能是 0（下架）或 1（发布）");
      status = next;
    }
    run("UPDATE announcements SET title = ?, content = ?, status = ? WHERE id = ?", [
      title,
      content,
      status,
      id,
    ]);
    logOperation(identity, "update_announcement", "announcement", id, `${existing.title} → ${title}`, req);
    ok(
      res,
      get("SELECT * FROM announcements WHERE id = ?", [id]),
      status === 1 ? "公告已更新" : "公告已下架，前台不再展示",
    );
    return true;
  }

  // 彻底删除不可逆，比"下架"更重，按破坏性后台操作要求超级管理员。
  // 一般撤回公告用上面的下架即可；删除只留给发错的测试公告。
  if (method === "DELETE" && adminAnnouncementMatch) {
    requireSuperAdmin(identity);
    const id = Number(adminAnnouncementMatch[1]);
    const existing = get("SELECT id, title FROM announcements WHERE id = ?", [id]);
    if (!existing) throw new HttpError(404, "公告不存在");
    run("DELETE FROM announcements WHERE id = ?", [id]);
    logOperation(identity, "delete_announcement", "announcement", id, existing.title, req);
    ok(res, null, "公告已删除");
    return true;
  }

  return false;
};
