const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { signToken, verifyPassword, verifyToken } = require("./auth");
const { all, db, get, now, parseJson, run, transaction } = require("./db");
const {
  exchangeCodeForSession,
  isMockLoginEnabled,
  isWeChatConfigured,
  validateWeChatConfiguration,
} = require("./wechat");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const serviceFeeRate = Number(process.env.SERVICE_FEE_RATE || 0);
const rechargeMode = process.env.WECHAT_PAY_MODE || "mock";
const withdrawMode = process.env.WECHAT_TRANSFER_MODE || "mock";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const rateLimitStore = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function ok(res, data = null, msg = "success") {
  sendJson(res, 200, { code: 200, msg, data });
}

function fail(res, error) {
  const status = error.status || 500;
  sendJson(res, status, {
    code: status,
    msg: error.status ? error.message : "服务器处理请求失败",
    data: null,
  });
  if (!error.status) console.error(error);
}

function requireValue(condition, message) {
  if (!condition) throw new HttpError(400, message);
}

function optionalText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function publicUser(user) {
  const { openid, ...safeUser } = user;
  return safeUser;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        reject(new HttpError(413, "请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "请求数据不是有效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function authenticate(req, adminOnly = false) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) throw new HttpError(401, "登录状态已失效，请重新登录");
  if (adminOnly && payload.type !== "admin") throw new HttpError(403, "无管理员权限");
  if (payload.type === "admin") {
    const admin = get("SELECT id FROM admins WHERE id = ? AND status = 1", [payload.id]);
    if (!admin) throw new HttpError(401, "管理员账号不存在或已被停用");
  }
  if (payload.type === "user") {
    const user = get("SELECT * FROM users WHERE id = ? AND status = 1", [payload.id]);
    if (!user) throw new HttpError(401, "账号不存在或已被禁用");
  }
  return payload;
}

function enforceRateLimit(req, bucket, limit = 120, windowMs = 60_000) {
  const key = `${req.socket.remoteAddress}:${bucket}`;
  const current = rateLimitStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (current.resetAt < Date.now()) {
    current.count = 0;
    current.resetAt = Date.now() + windowMs;
  }
  current.count += 1;
  rateLimitStore.set(key, current);
  if (current.count > limit) throw new HttpError(429, "操作过于频繁，请稍后再试");
}

// 周期性清理过期的限流计数，避免长时间运行后 Map 无限增长
setInterval(() => {
  const nowTs = Date.now();
  for (const [key, item] of rateLimitStore) {
    if (item.resetAt < nowTs) rateLimitStore.delete(key);
  }
}, 60_000).unref();

// 关键操作审计日志，失败不影响主流程
function logOperation(identity, action, targetType, targetId, detail, req) {
  try {
    run(
      `INSERT INTO operation_logs
        (operator_type, operator_id, action, target_type, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        identity?.type === "admin" ? 2 : 1,
        identity?.id || null,
        action,
        targetType,
        targetId ?? null,
        String(detail || "").slice(0, 500),
        req?.socket?.remoteAddress || "",
      ],
    );
  } catch (error) {
    console.warn("审计日志写入失败:", error.message);
  }
}

function maskPhone(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 11) {
    return digits.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
  }
  if (raw.includes("*")) return raw;
  if (raw.length > 7) return raw.slice(0, 3) + "****" + raw.slice(-4);
  return raw;
}

// 基于浏览者社区与任务地址的确定性距离估算（无地图服务时的就近口径）：
// 同社区 0.2-1.4km，跨社区 1.5-2.9km；数值只用于展示与就近排序，不代表精确测距
function estimateDistanceKm(row, viewerCommunity = "") {
  const community = String(viewerCommunity || "").trim();
  const target = `${row.delivery_address || ""}${row.pickup_address || ""}`;
  if (!target) return null;
  const sameCommunity = Boolean(community) && target.includes(community);
  if (sameCommunity) {
    return Number((0.2 + (Number(row.id * 37) % 13) / 10).toFixed(1));
  }
  return Number((1.5 + (Number(row.id * 17) % 15) / 10).toFixed(1));
}

function taskView(row, viewerId = null, canViewSensitive = false, viewerCommunity = "") {
  if (!row) return null;
  const canContact =
    canViewSensitive ||
    Boolean(
      viewerId &&
        (Number(viewerId) === Number(row.publisher_id) ||
          Number(viewerId) === Number(row.acceptor_id)),
    );
  return {
    ...row,
    contact_name: canContact ? row.contact_name : row.contact_name ? "发布者" : "",
    contact_phone: canContact ? row.contact_phone : maskPhone(row.contact_phone),
    publisher_phone: canContact ? row.publisher_phone : maskPhone(row.publisher_phone),
    images: parseJson(row.images),
    completion_images: parseJson(row.completion_images),
    distance_km: estimateDistanceKm(row, viewerCommunity),
    same_community: Boolean(
      viewerCommunity &&
        `${row.delivery_address || ""}${row.pickup_address || ""}`.includes(viewerCommunity),
    ),
    can_accept:
      Number(row.status) === 0 &&
      Number(row.publisher_id) !== Number(viewerId) &&
      Boolean(viewerId),
    can_contact: canContact,
  };
}

function orderView(row) {
  if (!row) return null;
  return {
    ...row,
    task_images: parseJson(row.task_images),
    completion_images: parseJson(row.completion_images),
  };
}

function ensureTask(id) {
  const task = get(
    `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.address_mode AS category_address_mode,
      u.nickname AS publisher_name, u.phone AS publisher_phone,
      u.community AS publisher_community, u.credit_score AS publisher_credit
     FROM tasks t
     JOIN categories c ON c.id = t.category_id
     JOIN users u ON u.id = t.publisher_id
     WHERE t.id = ?`,
    [id],
  );
  if (!task) throw new HttpError(404, "任务不存在");
  return task;
}

function ensureOrder(id) {
  const order = get(
    `SELECT o.*, t.title, t.description, t.pickup_address, t.delivery_address,
      t.contact_name, t.contact_phone, t.expect_time, t.finished_at, t.images AS task_images,
      t.completion_images, t.status AS task_status,
      c.name AS category_name, c.icon AS category_icon, c.address_mode AS category_address_mode,
      pu.nickname AS publisher_name, pu.phone AS publisher_phone,
      ac.nickname AS acceptor_name, ac.phone AS acceptor_phone
     FROM orders o
     JOIN tasks t ON t.id = o.task_id
     JOIN categories c ON c.id = t.category_id
     JOIN users pu ON pu.id = o.publisher_id
     JOIN users ac ON ac.id = o.acceptor_id
     WHERE o.id = ?`,
    [id],
  );
  if (!order) throw new HttpError(404, "订单不存在");
  return order;
}

function canViewOrder(order, identity) {
  if (identity.type === "admin") return true;
  return [order.publisher_id, order.acceptor_id].includes(Number(identity.id));
}

function createMessage(userId, title, content, type, relatedId = null) {
  run(
    "INSERT INTO messages (user_id, title, content, type, related_id) VALUES (?, ?, ?, ?, ?)",
    [userId, title, content, type, relatedId],
  );
}

function createOrderNumber() {
  const date = new Date();
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  return `SQ${datePart}${String(Date.now()).slice(-7)}${crypto.randomInt(10, 99)}`;
}

function buildTaskWhere(url, viewerId) {
  const where = ["t.status = 0"];
  const params = [];
  const categoryId = url.searchParams.get("categoryId");
  const keyword = url.searchParams.get("keyword");
  if (categoryId) {
    where.push("t.category_id = ?");
    params.push(Number(categoryId));
  }
  if (keyword) {
    where.push("(t.title LIKE ? OR t.description LIKE ? OR t.delivery_address LIKE ?)");
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }
  where.push("t.publisher_id <> ?");
  params.push(viewerId || 0);
  return { where: where.join(" AND "), params };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "POST" && pathname === "/api/auth/login") {
    enforceRateLimit(req, "login", 30);
    const body = await parseBody(req);
    const session = await exchangeCodeForSession(body.code, body.deviceId);
    const openid = session.openid.slice(0, 64);
    let user = get("SELECT * FROM users WHERE openid = ?", [openid]);
    let isNewUser = false;
    if (!user) {
      const nickname =
        optionalText(body.nickname, 64) || `微信用户${openid.slice(-6)}`;
      const result = run(
        `INSERT OR IGNORE INTO users
          (openid, nickname, avatar_url, phone, community, balance)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [
          openid,
          nickname,
          optionalText(body.avatarUrl, 255),
          optionalText(body.phone, 20),
          optionalText(body.community, 100) || "阳光社区",
        ],
      );
      isNewUser = Number(result.changes) === 1;
      user = get("SELECT * FROM users WHERE openid = ?", [openid]);
      if (isNewUser) {
        run("UPDATE users SET uid = ? WHERE id = ?", [`SQ${100000 + Number(user.id)}`, user.id]);
        user = get("SELECT * FROM users WHERE id = ?", [user.id]);
        createMessage(
          user.id,
          "欢迎加入阳光社区",
          "微信登录成功，账号已自动创建。完善个人资料后即可发布或接取邻里任务。",
          1,
        );
      }
    }
    if (!user) throw new HttpError(500, "微信用户创建失败，请重试");
    if (Number(user.status) !== 1) throw new HttpError(403, "账号已被禁用");
    const token = signToken({ id: Number(user.id), type: "user" });
    return ok(res, {
      token,
      user: publicUser(user),
      is_new_user: isNewUser,
      login_mode: session.mock ? "mock" : "wechat",
    });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    enforceRateLimit(req, "admin-login", 20);
    const body = await parseBody(req);
    const admin = get("SELECT * FROM admins WHERE username = ? AND status = 1", [
      String(body.username || ""),
    ]);
    if (!admin || !verifyPassword(String(body.password || ""), admin.password_hash)) {
      throw new HttpError(401, "管理员账号或密码错误");
    }
    run("UPDATE admins SET last_login_at = ? WHERE id = ?", [now(), admin.id]);
    const token = signToken({ id: Number(admin.id), type: "admin" });
    return ok(res, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        real_name: admin.real_name,
        role: admin.role,
      },
    });
  }

  const publicPaths =
    method === "GET" &&
    ["/api/config", "/api/categories", "/api/tasks"].includes(pathname);
  let identity = null;
  if (!publicPaths) {
    identity = authenticate(req, pathname.startsWith("/api/admin/"));
  } else if (req.headers.authorization) {
    identity = verifyToken(req.headers.authorization.replace("Bearer ", ""));
  }

  if (method === "GET" && pathname === "/api/config") {
    const announcements = all(
      "SELECT id, title, content, created_at FROM announcements WHERE status = 1 ORDER BY id DESC LIMIT 3",
    );
    return ok(res, {
      app_name: "阳光社区邻里快办",
      service_fee_rate: serviceFeeRate,
      recharge_mode: rechargeMode,
      withdraw_mode: withdrawMode,
      announcements,
    });
  }

  if (method === "GET" && pathname === "/api/categories") {
    return ok(res, all("SELECT * FROM categories WHERE status = 1 ORDER BY sort, id"));
  }

  if (method === "GET" && pathname === "/api/tasks") {
    const viewerId = identity?.type === "user" ? identity.id : null;
    const viewer = viewerId
      ? get("SELECT community FROM users WHERE id = ?", [viewerId])
      : null;
    const viewerCommunity = viewer?.community || "";
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
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") || 20)));
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
    return ok(res, {
      list: rows.map((row) => taskView(row, viewerId, false, viewerCommunity)),
      total,
      page,
      pageSize,
    });
  }

  // 图片上传：接收 base64 dataURL，落盘到 public/uploads 并返回可访问 URL；
  // 生产环境可把本函数内部替换为对象存储（OSS/COS）上传，接口契约保持不变
  if (method === "POST" && pathname === "/api/upload") {
    enforceRateLimit(req, "upload", 60);
    const body = await parseBody(req);
    const dataUrl = String(body.dataUrl || "");
    const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
    requireValue(match, "仅支持 jpg、png、webp 格式图片");
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    let buffer;
    try {
      buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    } catch {
      throw new HttpError(400, "图片数据无效");
    }
    requireValue(buffer.length > 0, "图片数据无效");
    requireValue(buffer.length <= 5 * 1024 * 1024, "图片大小不能超过 5MB");
    const uploadDir = path.join(PUBLIC_DIR, "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const fileName = `u${Date.now()}${crypto.randomInt(1000, 9999)}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
    logOperation(identity, "upload_image", "file", null, `${fileName}, ${buffer.length}B`, req);
    return ok(res, { url: `/uploads/${fileName}` }, "上传成功");
  }

  if (method === "POST" && pathname === "/api/tasks") {
    enforceRateLimit(req, "publish-task", 30);
    const userId = Number(identity.id);
    const body = await parseBody(req);
    const reward = Number(body.reward);
    requireValue(body.categoryId, "请选择服务分类");
    requireValue(String(body.title || "").trim().length >= 4, "任务标题至少 4 个字");
    requireValue(Number.isFinite(reward) && reward >= 1 && reward <= 5000, "报酬金额需在 1-5000 元之间");
    const user = get("SELECT * FROM users WHERE id = ?", [userId]);
    requireValue(user.balance >= reward, "余额不足，请先充值后再发布");
    const result = transaction(() => {
      const taskResult = run(
        `INSERT INTO tasks (
          publisher_id, category_id, title, description, pickup_address, delivery_address,
          contact_name, contact_phone, expect_time, reward, images, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          userId,
          Number(body.categoryId),
          String(body.title).trim(),
          String(body.description || "").trim(),
          String(body.pickupAddress || "").trim(),
          String(body.deliveryAddress || "").trim(),
          String(body.contactName || user.nickname).trim(),
          String(body.contactPhone || user.phone).trim(),
          body.expectTime || null,
          reward,
          JSON.stringify(body.images || []),
        ],
      );
      const taskId = Number(taskResult.lastInsertRowid);
      const balance = Number((user.balance - reward).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), userId]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 2, ?, ?, ?)`,
        [userId, -reward, balance, `发布任务“${String(body.title).trim()}”托管`],
      );
      return taskId;
    });
    logOperation(identity, "publish_task", "task", result, `¥${reward}`, req);
    return ok(
      res,
      taskView(ensureTask(result), userId, true, user.community),
      "任务已发布并完成费用托管",
    );
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (method === "GET" && taskMatch) {
    const id = Number(taskMatch[1]);
    const viewer = identity?.type === "user"
      ? get("SELECT community FROM users WHERE id = ?", [identity.id])
      : null;
    return ok(res, taskView(ensureTask(id), identity?.id, false, viewer?.community || ""));
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
      if (task.status !== 0) throw new HttpError(409, "任务已被其他邻居接取");
      const changed = run(
        `UPDATE tasks SET status = 1, acceptor_id = ?, accepted_at = ?, updated_at = ?
         WHERE id = ? AND status = 0`,
        [acceptorId, now(), now(), taskId],
      );
      if (Number(changed.changes) !== 1) throw new HttpError(409, "任务已被其他邻居接取");
      const orderNo = createOrderNumber();
      const orderResult = run(
        `INSERT INTO orders (
          order_no, task_id, publisher_id, acceptor_id, amount, status, pay_status, pay_time
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
        [orderNo, taskId, task.publisher_id, acceptorId, task.reward, now()],
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
    return ok(res, orderView(ensureOrder(orderId)), "接单成功");
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
      if (![0, 1].includes(task.status)) throw new HttpError(409, "当前状态不能取消");
      const user = get("SELECT balance FROM users WHERE id = ?", [userId]);
      const balance = Number((user.balance + task.reward).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), userId]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 3, ?, ?, ?)`,
        [userId, task.reward, balance, `取消任务“${task.title}”退款`],
      );
      run(
        "UPDATE tasks SET status = 5, updated_at = ? WHERE id = ?",
        [now(), taskId],
      );
      const order = get("SELECT * FROM orders WHERE task_id = ?", [taskId]);
      if (order) {
        run(
          "UPDATE orders SET status = 4, pay_status = 3, cancel_reason = ?, updated_at = ? WHERE id = ?",
          [String(body.reason || "发布者取消"), now(), order.id],
        );
        createMessage(order.acceptor_id, "订单已取消", `“${task.title}”已由发布者取消。`, 3, order.id);
      }
    });
    logOperation(identity, "cancel_task", "task", taskId, String(body.reason || "发布者取消"), req);
    return ok(res, null, "任务已取消，托管费用已退回");
  }

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
    return ok(res, { ...user, stats });
  }

  if (method === "PUT" && pathname === "/api/user/profile") {
    const body = await parseBody(req);
    run(
      `UPDATE users SET nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url),
        phone = COALESCE(?, phone), community = COALESCE(?, community),
        building = COALESCE(?, building), room = COALESCE(?, room), updated_at = ?
       WHERE id = ?`,
      [
        body.nickname ?? null,
        body.avatarUrl ?? null,
        body.phone ?? null,
        body.community ?? null,
        body.building ?? null,
        body.room ?? null,
        now(),
        identity.id,
      ],
    );
    return ok(res, get("SELECT * FROM users WHERE id = ?", [identity.id]), "资料已更新");
  }

  if (method === "GET" && pathname === "/api/addresses") {
    return ok(
      res,
      all("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", [identity.id]),
    );
  }

  if (method === "POST" && pathname === "/api/addresses") {
    const body = await parseBody(req);
    requireValue(body.contactName && body.phone && body.community, "请填写联系人、电话和社区");
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
          body.contactName,
          body.phone,
          body.community,
          body.building || "",
          body.room || "",
          body.detail || "",
          body.isDefault ? 1 : 0,
          Number(body.addressType) === 2 ? 2 : 1,
        ],
      );
    });
    return ok(res, get("SELECT * FROM addresses WHERE id = ?", [result.lastInsertRowid]), "地址已新增");
  }

  const addressMatch = pathname.match(/^\/api\/addresses\/(\d+)$/);
  if (method === "PUT" && addressMatch) {
    const body = await parseBody(req);
    const address = get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", [
      Number(addressMatch[1]),
      identity.id,
    ]);
    if (!address) throw new HttpError(404, "地址不存在");
    transaction(() => {
      if (body.isDefault) {
        run("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [identity.id]);
      }
      run(
        `UPDATE addresses SET contact_name = ?, phone = ?, community = ?, building = ?,
          room = ?, detail = ?, is_default = ?, address_type = ? WHERE id = ?`,
        [
          body.contactName ?? address.contact_name,
          body.phone ?? address.phone,
          body.community ?? address.community,
          body.building ?? address.building,
          body.room ?? address.room,
          body.detail ?? address.detail,
          body.isDefault === undefined ? address.is_default : body.isDefault ? 1 : 0,
          body.addressType === undefined ? address.address_type : Number(body.addressType) === 2 ? 2 : 1,
          address.id,
        ],
      );
    });
    return ok(res, null, "地址已更新");
  }

  if (method === "DELETE" && addressMatch) {
    const result = run("DELETE FROM addresses WHERE id = ? AND user_id = ?", [
      Number(addressMatch[1]),
      identity.id,
    ]);
    if (!result.changes) throw new HttpError(404, "地址不存在");
    return ok(res, null, "地址已删除");
  }

  if (method === "GET" && pathname === "/api/orders") {
    const role = url.searchParams.get("role") || "published";
    const status = url.searchParams.get("status");
    const where = [role === "accepted" ? "o.acceptor_id = ?" : "o.publisher_id = ?"];
    const params = [identity.id];
    if (status !== null && status !== "") {
      where.push("o.status = ?");
      params.push(Number(status));
    }
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") || 20)));
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
    return ok(res, { list, total, page, pageSize });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/(\d+)$/);
  if (method === "GET" && orderMatch) {
    const order = ensureOrder(Number(orderMatch[1]));
    if (!canViewOrder(order, identity)) throw new HttpError(403, "无权查看该订单");
    return ok(res, {
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
  }

  const startMatch = pathname.match(/^\/api\/orders\/(\d+)\/start$/);
  if (method === "POST" && startMatch) {
    const order = ensureOrder(Number(startMatch[1]));
    if (order.acceptor_id !== Number(identity.id)) throw new HttpError(403, "只有接单者可以开始服务");
    if (order.status === 5) throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    if (order.status !== 1) throw new HttpError(409, "当前订单不能开始服务");
    transaction(() => {
      run("UPDATE orders SET status = 2, updated_at = ? WHERE id = ?", [now(), order.id]);
      run("UPDATE tasks SET status = 2, updated_at = ? WHERE id = ?", [now(), order.task_id]);
      createMessage(order.publisher_id, "订单已开始", `“${order.title}”已开始服务。`, 3, order.id);
    });
    logOperation(identity, "start_order", "order", order.id, "", req);
    return ok(res, orderView(ensureOrder(order.id)), "已开始服务");
  }

  const finishMatch = pathname.match(/^\/api\/orders\/(\d+)\/finish$/);
  if (method === "POST" && finishMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(finishMatch[1]));
    if (order.acceptor_id !== Number(identity.id)) throw new HttpError(403, "只有接单者可以提交完成");
    if (order.status === 5) throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    if (order.status !== 2) throw new HttpError(409, "订单当前不可提交完成");
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    requireValue(images.length, "请至少上传一张完成凭证");
    transaction(() => {
      run(
        "UPDATE orders SET status = 2, updated_at = ? WHERE id = ?",
        [now(), order.id],
      );
      run(
        `UPDATE tasks SET status = 3, finished_at = ?, completion_images = ?, updated_at = ?
         WHERE id = ?`,
        [now(), JSON.stringify(images), now(), order.task_id],
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
    return ok(res, orderView(ensureOrder(order.id)), "完成凭证已提交");
  }

  const confirmMatch = pathname.match(/^\/api\/orders\/(\d+)\/confirm$/);
  if (method === "POST" && confirmMatch) {
    const order = ensureOrder(Number(confirmMatch[1]));
    if (order.publisher_id !== Number(identity.id)) throw new HttpError(403, "只有发布者可以确认完成");
    if (order.status === 5) throw new HttpError(409, "订单存在争议，已暂停操作，等待管理员处理");
    if (order.task_status !== 3 || order.status !== 2) throw new HttpError(409, "订单当前不可确认");
    transaction(() => {
      run(
        "UPDATE orders SET status = 3, pay_status = 2, confirm_time = ?, updated_at = ? WHERE id = ?",
        [now(), now(), order.id],
      );
      run("UPDATE tasks SET status = 4, updated_at = ? WHERE id = ?", [now(), order.task_id]);
      const acceptor = get("SELECT balance FROM users WHERE id = ?", [order.acceptor_id]);
      const income = Number((order.amount * (1 - serviceFeeRate)).toFixed(2));
      const balance = Number((acceptor.balance + income).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [
        balance,
        now(),
        order.acceptor_id,
      ]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, ?, 1, ?, ?, ?)`,
        [order.acceptor_id, order.id, income, balance, `订单“${order.title}”结算`],
      );
      createMessage(order.acceptor_id, "订单已结算", `“${order.title}”已确认完成，报酬已到账。`, 3, order.id);
    });
    logOperation(identity, "confirm_order", "order", order.id, `¥${order.amount}`, req);
    return ok(res, orderView(ensureOrder(order.id)), "订单已完成，报酬已结算");
  }

  const cancelOrderMatch = pathname.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (method === "POST" && cancelOrderMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(cancelOrderMatch[1]));
    if (!canViewOrder(order, identity)) throw new HttpError(403, "无权操作该订单");
    if (order.status === 5) throw new HttpError(409, "订单存在争议，需等待管理员处理结果");
    // 接单者已提交完成凭证后，资金不能由单方取消退回，避免接单者白干；有异议走投诉
    if (Number(order.task_status) === 3) {
      throw new HttpError(409, "对方已提交完成凭证，不能直接取消；如有异议请发起投诉");
    }
    if (![1, 2].includes(order.status)) throw new HttpError(409, "当前订单不可取消");
    transaction(() => {
      run(
        "UPDATE orders SET status = 4, pay_status = 3, cancel_reason = ?, updated_at = ? WHERE id = ?",
        [String(body.reason || "双方协商取消"), now(), order.id],
      );
      run("UPDATE tasks SET status = 5, updated_at = ? WHERE id = ?", [now(), order.task_id]);
      const publisher = get("SELECT balance FROM users WHERE id = ?", [order.publisher_id]);
      const balance = Number((publisher.balance + order.amount).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [
        balance,
        now(),
        order.publisher_id,
      ]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, ?, 3, ?, ?, ?)`,
        [order.publisher_id, order.id, order.amount, balance, `订单“${order.title}”取消退款`],
      );
      createMessage(order.acceptor_id, "订单已取消", `“${order.title}”已取消。`, 3, order.id);
    });
    logOperation(identity, "cancel_order", "order", order.id, String(body.reason || ""), req);
    return ok(res, orderView(ensureOrder(order.id)), "订单已取消");
  }

  const reviewMatch = pathname.match(/^\/api\/orders\/(\d+)\/review$/);
  if (method === "POST" && reviewMatch) {
    const body = await parseBody(req);
    const order = ensureOrder(Number(reviewMatch[1]));
    if (!canViewOrder(order, identity) || identity.type === "admin") {
      throw new HttpError(403, "只有订单参与双方可以评价");
    }
    if (order.status !== 3) throw new HttpError(409, "订单完成后才能评价");
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
    const creditAdjust = Number(body.rating) >= 4 ? 1 : Number(body.rating) <= 2 ? -2 : 0;
    run(
      `UPDATE users SET credit_score = MAX(0, MIN(100, credit_score + ?)), updated_at = ?
       WHERE id = ?`,
      [creditAdjust, now(), revieweeId],
    );
    createMessage(
      revieweeId,
      "收到新评价",
      `你收到一条 ${Number(body.rating)} 星评价，当前平均评分 ${Number(avg).toFixed(1)}。`,
      3,
      order.id,
    );
    return ok(res, get("SELECT * FROM reviews WHERE id = ?", [result.lastInsertRowid]), "评价已提交");
  }

  if (method === "GET" && pathname === "/api/messages") {
    const type = url.searchParams.get("type");
    const params = [identity.id];
    let where = "user_id = ?";
    if (type) {
      where += " AND type = ?";
      params.push(Number(type));
    }
    return ok(res, all(`SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC`, params));
  }

  const readMessageMatch = pathname.match(/^\/api\/messages\/(\d+)\/read$/);
  if (method === "POST" && readMessageMatch) {
    run("UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?", [
      Number(readMessageMatch[1]),
      identity.id,
    ]);
    return ok(res, null, "消息已读");
  }

  if (method === "POST" && pathname === "/api/messages/read-all") {
    run("UPDATE messages SET is_read = 1 WHERE user_id = ?", [identity.id]);
    return ok(res, null, "全部消息已读");
  }

  if (method === "POST" && pathname === "/api/wallet/recharge") {
    enforceRateLimit(req, "wallet-recharge", 20);
    const body = await parseBody(req);
    const amount = Number(Number(body.amount || 0).toFixed(2));
    requireValue(Number.isFinite(amount) && amount >= 1 && amount <= 1000, "充值金额需在 1-1000 元之间");
    if (rechargeMode !== "mock") {
      throw new HttpError(501, "微信商户支付尚未配置，请先配置商户号和支付证书");
    }
    const rechargeNo = `RC${Date.now()}${crypto.randomInt(10, 99)}`;
    const result = transaction(() => {
      const orderResult = run(
        `INSERT INTO recharge_orders (recharge_no, user_id, amount, status, pay_mode, paid_at)
         VALUES (?, ?, ?, 1, 'mock', ?)`,
        [rechargeNo, identity.id, amount, now()],
      );
      const user = get("SELECT balance FROM users WHERE id = ?", [identity.id]);
      const balance = Number((Number(user.balance) + amount).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), identity.id]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 4, ?, ?, ?)`,
        [identity.id, amount, balance, "微信充值（模拟）"],
      );
      return { rechargeId: Number(orderResult.lastInsertRowid), rechargeNo, amount, balance };
    });
    logOperation(identity, "wallet_recharge", "wallet", null, `¥${amount}`, req);
    return ok(res, { ...result, mode: "mock", paid: true }, "充值成功");
  }

  if (method === "POST" && pathname === "/api/wallet/withdraw") {
    enforceRateLimit(req, "wallet-withdraw", 20);
    const body = await parseBody(req);
    const amount = Number(Number(body.amount || 0).toFixed(2));
    requireValue(Number.isFinite(amount) && amount >= 1 && amount <= 1000, "提现金额需在 1-1000 元之间");
    if (withdrawMode !== "mock") {
      throw new HttpError(501, "微信企业付款尚未配置，请先配置商户号和支付证书");
    }
    const result = transaction(() => {
      const user = get("SELECT balance FROM users WHERE id = ?", [identity.id]);
      requireValue(Number(user.balance) >= amount, "余额不足，无法提现");
      const withdrawNo = `WD${Date.now()}${crypto.randomInt(10, 99)}`;
      run(
        `INSERT INTO withdraw_orders (withdraw_no, user_id, amount, status, pay_mode, paid_at)
         VALUES (?, ?, ?, 1, 'mock', ?)`,
        [withdrawNo, identity.id, amount, now()],
      );
      const balance = Number((Number(user.balance) - amount).toFixed(2));
      run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), identity.id]);
      run(
        `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
         VALUES (?, NULL, 5, ?, ?, ?)`,
        [identity.id, -amount, balance, "微信提现（模拟）"],
      );
      return { withdrawNo, amount, balance };
    });
    logOperation(identity, "wallet_withdraw", "wallet", null, `¥${amount}`, req);
    return ok(res, { ...result, mode: "mock", paid: true }, "提现成功");
  }

  if (method === "GET" && pathname === "/api/wallet") {
    const user = get("SELECT balance FROM users WHERE id = ?", [identity.id]);
    return ok(res, {
      balance: user.balance,
      records: all(
        "SELECT * FROM wallet_records WHERE user_id = ? ORDER BY created_at DESC, id DESC",
        [identity.id],
      ),
    });
  }

  if (method === "GET" && pathname === "/api/reviews") {
    return ok(
      res,
      all(
        `SELECT r.*, u.nickname AS reviewer_name, t.title AS task_title
         FROM reviews r
         JOIN users u ON u.id = r.reviewer_id
         JOIN orders o ON o.id = r.order_id
         JOIN tasks t ON t.id = o.task_id
         WHERE r.reviewee_id = ?
         ORDER BY r.created_at DESC`,
        [identity.id],
      ),
    );
  }

  if (method === "GET" && pathname === "/api/complaints") {
    return ok(
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
  }

  if (method === "POST" && pathname === "/api/complaints") {
    const body = await parseBody(req);
    const order = ensureOrder(Number(body.orderId));
    if (!canViewOrder(order, identity) || identity.type === "admin") {
      throw new HttpError(403, "只有订单参与双方可以投诉");
    }
    requireValue(body.reason, "请选择投诉原因");
    if (order.status === 5) throw new HttpError(409, "该订单已在争议处理中，请勿重复投诉");
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
          String(body.reason),
          String(body.description || ""),
          JSON.stringify(images),
        ],
      );
      run("UPDATE tasks SET status = 6, updated_at = ? WHERE id = ?", [now(), order.task_id]);
      // 资金尚未结算（进行中/待确认）时冻结订单，裁决前任何一方都不能推进或取消
      if ([1, 2].includes(Number(order.status))) {
        run(
          "UPDATE orders SET frozen_status = status, status = 5, updated_at = ? WHERE id = ?",
          [now(), order.id],
        );
      }
      createMessage(respondentId, "收到订单投诉", `订单“${order.title}”已发起投诉，等待管理员处理。`, 4, order.id);
      logOperation(identity, "submit_complaint", "complaint", Number(result.lastInsertRowid), String(body.reason), req);
    });
    const latest = get("SELECT * FROM complaints WHERE order_id = ? ORDER BY id DESC LIMIT 1", [order.id]);
    return ok(res, latest, "投诉已提交");
  }

  if (method === "GET" && pathname === "/api/admin/dashboard") {
    const userCount = get("SELECT COUNT(*) AS total FROM users").total;
    const taskCount = get("SELECT COUNT(*) AS total FROM tasks").total;
    const orderCount = get("SELECT COUNT(*) AS total FROM orders").total;
    const transactionAmount = get(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = 3",
    ).total;
    const pendingComplaints = get("SELECT COUNT(*) AS total FROM complaints WHERE status IN (0, 1)").total;
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
    return ok(res, {
      metrics: { userCount, taskCount, orderCount, transactionAmount, pendingComplaints },
      statusDistribution,
      recentOrders,
    });
  }

  if (method === "GET" && pathname === "/api/admin/users") {
    const keyword = url.searchParams.get("keyword") || "";
    // 用相关子查询统计，避免 GROUP BY u.* 在 MySQL ONLY_FULL_GROUP_BY 下报错
    return ok(
      res,
      all(
        `SELECT u.*,
          (SELECT COUNT(*) FROM tasks t WHERE t.publisher_id = u.id) AS published_count,
          (SELECT COUNT(*) FROM orders o WHERE o.acceptor_id = u.id) AS accepted_count
         FROM users u
         WHERE u.nickname LIKE ? OR u.uid LIKE ? OR u.phone LIKE ? OR u.community LIKE ?
         ORDER BY u.id DESC`,
        [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`],
      ),
    );
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
  if (method === "PUT" && adminUserMatch) {
    const body = await parseBody(req);
    const targetId = Number(adminUserMatch[1]);
    run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", [
      body.status ? 1 : 0,
      now(),
      targetId,
    ]);
    logOperation(identity, "set_user_status", "user", targetId, body.status ? "启用" : "禁用", req);
    return ok(res, null, "用户状态已更新");
  }

  if (method === "GET" && pathname === "/api/admin/tasks") {
    const keyword = url.searchParams.get("keyword") || "";
    return ok(
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
  }

  const adminTaskMatch = pathname.match(/^\/api\/admin\/tasks\/(\d+)\/status$/);
  if (method === "PUT" && adminTaskMatch) {
    const body = await parseBody(req);
    const targetId = Number(adminTaskMatch[1]);
    run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
      Number(body.status),
      now(),
      targetId,
    ]);
    logOperation(identity, "set_task_status", "task", targetId, `状态 ${body.status}`, req);
    return ok(res, null, "任务状态已更新");
  }

  if (method === "GET" && pathname === "/api/admin/orders") {
    const status = url.searchParams.get("status");
    const params = [];
    let where = "1 = 1";
    if (status !== null && status !== "") {
      where += " AND o.status = ?";
      params.push(Number(status));
    }
    return ok(
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
  }

  if (method === "GET" && pathname === "/api/admin/categories") {
    return ok(res, all("SELECT * FROM categories ORDER BY sort, id"));
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
    return ok(res, get("SELECT * FROM categories WHERE id = ?", [result.lastInsertRowid]), "分类已新增");
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
    return ok(res, null, "分类已更新");
  }

  if (method === "GET" && pathname === "/api/admin/complaints") {
    return ok(
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
  }

  const adminComplaintMatch = pathname.match(/^\/api\/admin\/complaints\/(\d+)$/);
  if (method === "PUT" && adminComplaintMatch) {
    const body = await parseBody(req);
    const complaint = get("SELECT * FROM complaints WHERE id = ?", [Number(adminComplaintMatch[1])]);
    if (!complaint) throw new HttpError(404, "投诉记录不存在");
    const verdict = String(body.verdict || ""); // refund 退款给发布者 / pay 结算给接单者 / reject 驳回
    const handleResult = String(body.handleResult || "");
    const finalStatus = Number(body.status ?? (verdict === "reject" ? 3 : verdict ? 2 : 2));
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
        const moneyFrozen = [1, 2, 5].includes(Number(order.status)) && Number(order.pay_status) === 1;
        if (verdict === "refund") {
          // 投诉成立、服务未完成：托管款退回发布者
          if (moneyFrozen) {
            const publisher = get("SELECT balance FROM users WHERE id = ?", [order.publisher_id]);
            const balance = Number((Number(publisher.balance) + Number(order.amount)).toFixed(2));
            run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [
              balance,
              now(),
              order.publisher_id,
            ]);
            run(
              `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
               VALUES (?, ?, 3, ?, ?, ?)`,
              [order.publisher_id, order.id, order.amount, balance, `投诉裁决退款“${order.title}”`],
            );
          }
          run(
            "UPDATE orders SET status = 4, pay_status = 3, frozen_status = NULL, cancel_reason = ?, updated_at = ? WHERE id = ?",
            ["投诉裁决退款", now(), order.id],
          );
          run("UPDATE tasks SET status = 5, updated_at = ? WHERE id = ?", [now(), order.task_id]);
        } else if (verdict === "pay") {
          // 认定服务完成：托管款结算给接单者
          if (moneyFrozen) {
            const acceptor = get("SELECT balance FROM users WHERE id = ?", [order.acceptor_id]);
            const income = Number((Number(order.amount) * (1 - serviceFeeRate)).toFixed(2));
            const balance = Number((Number(acceptor.balance) + income).toFixed(2));
            run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [
              balance,
              now(),
              order.acceptor_id,
            ]);
            run(
              `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
               VALUES (?, ?, 1, ?, ?, ?)`,
              [order.acceptor_id, order.id, income, balance, `投诉裁决结算“${order.title}”`],
            );
          }
          run(
            "UPDATE orders SET status = 3, pay_status = 2, confirm_time = ?, frozen_status = NULL, updated_at = ? WHERE id = ?",
            [now(), now(), order.id],
          );
          run("UPDATE tasks SET status = 4, updated_at = ? WHERE id = ?", [now(), order.task_id]);
        } else if (verdict === "reject") {
          // 驳回：恢复争议冻结前的订单/任务状态
          if (order.frozen_status != null) {
            const frozen = Number(order.frozen_status);
            run("UPDATE orders SET status = frozen_status, frozen_status = NULL, updated_at = ? WHERE id = ?", [
              now(),
              order.id,
            ]);
            const taskStatus = frozen === 1 ? 1 : task.finished_at ? 3 : 2;
            run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
              taskStatus,
              now(),
              order.task_id,
            ]);
          }
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
    return ok(res, null, "投诉已处理");
  }

  if (method === "GET" && pathname === "/api/admin/logs") {
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 30)));
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
    return ok(res, { list, total, page, pageSize });
  }

  if (method === "GET" && pathname === "/api/admin/announcements") {
    return ok(res, all("SELECT * FROM announcements ORDER BY id DESC"));
  }

  if (method === "POST" && pathname === "/api/admin/announcements") {
    const body = await parseBody(req);
    requireValue(body.title && body.content, "公告标题和内容不能为空");
    const result = run("INSERT INTO announcements (title, content, status) VALUES (?, ?, 1)", [
      String(body.title),
      String(body.content),
    ]);
    return ok(res, get("SELECT * FROM announcements WHERE id = ?", [result.lastInsertRowid]), "公告已发布");
  }

  throw new HttpError(404, "接口不存在");
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    res.writeHead(302, { Location: "/preview/" });
    return res.end();
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404);
    return res.end("Not Found");
  }
  const ext = path.extname(target).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
  };
  res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    return fail(res, error);
  }
});

validateWeChatConfiguration();

server.listen(PORT, HOST, () => {
  console.log(`阳光社区邻里快办服务已启动: http://localhost:${PORT}`);
  console.log(`移动端预览: http://localhost:${PORT}/preview/`);
  console.log(`管理后台: http://localhost:${PORT}/admin/`);
  if (isMockLoginEnabled()) {
    console.warn("微信登录当前为本地模拟模式；生产环境请配置微信小程序密钥");
  } else {
    console.log(`微信登录: ${isWeChatConfigured() ? "code2Session 正式模式" : "等待配置"}`);
  }
});
