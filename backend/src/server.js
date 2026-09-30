const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SECRET_SOURCE, signToken, verifyPassword, verifyToken } = require("./auth");
const { all, db, get, now, parseJson, run, transaction } = require("./db");
const {
  HttpError,
  enforceRateLimit,
  fail,
  ok,
  optionalText,
  parseBody,
  readMoney,
  readPagination,
  requireValue,
  resolveCorsOrigin,
  sendJson,
} = require("./http");
const { clientAddress, isTrustedDemoRequest } = require("./network");
const {
  ACCEPTOR_STATUS,
  ACCEPTOR_STATUS_LABEL,
  COMPLAINT_STATUS,
  DEPOSIT_STATUS,
  ORDER_STATUS,
  PAY_STATUS,
  TASK_STATUS,
  TASK_STATUS_VALUES,
  WALLET_TYPE,
  deriveTaskStatus,
  describeAcceptorBlocker,
  isAcceptorActive,
} = require("./status");
const {
  acceptorView,
  maskIdCard,
  orderView,
  publicAdminUser,
  publicUser,
  taskView,
} = require("./views");
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
// 超级管理员角色值（admins.role）。资金裁决等破坏性操作要求 role >= SUPER_ADMIN_ROLE，
// 修复此前 admins.role 只在登录响应里回显、从不参与任何授权判断的问题
const SUPER_ADMIN_ROLE = 2;
// 信用分上限与交易门槛。修复此前 credit_score 既封顶 100（正向评价对高分用户无效）、
// 又完全不参与任何业务判断（纯装饰字段）的问题
const MAX_CREDIT_SCORE = 120;
const MIN_CREDIT_TO_TRADE = 60;
// 上传目录总量配额，防止"单文件 5MB + 高频调用"持续打满磁盘
const MAX_UPLOAD_FILES = 500;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
// 接单员保证金金额。接单意味着"平台把交付责任交给这个人"，
// 因此需要先实名认证再缴纳一笔可退还的保证金，用于约束履约。
const ACCEPTOR_DEPOSIT_AMOUNT = Number(process.env.ACCEPTOR_DEPOSIT || 50);
// 身份证校验位算法（GB 11643-1999）
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CHARS = "10X98765432";

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

// 可选字段清洗：undefined / null 表示"本次不修改"（保持数据库原值），
// 其余值统一 trim 并截断到最大长度。修复此前改资料/加地址直接透传原始输入、
// 既无长度上限也未清洗的问题（原审计问题 #10）。
function pickText(value, maxLength) {
  return value === undefined || value === null ? null : optionalText(value, maxLength);
}

// 身份证号校验：18 位、出生日期真实存在、校验位符合 GB 11643-1999。
// 只校验"格式与校验位"是行业通行做法——无法也不应在本系统内联网核验真伪，
// 真实核验依赖管理员比对上传的证件照片。
function readIdCardNo(value) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");
  requireValue(/^\d{17}[\dX]$/.test(raw), "身份证号格式不正确，应为 18 位");
  const year = Number(raw.slice(6, 10));
  const month = Number(raw.slice(10, 12));
  const day = Number(raw.slice(12, 14));
  const birth = new Date(year, month - 1, day);
  requireValue(
    year >= 1900 &&
      year <= new Date().getFullYear() &&
      birth.getFullYear() === year &&
      birth.getMonth() === month - 1 &&
      birth.getDate() === day,
    "身份证号中的出生日期不正确",
  );
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(raw[index]) * ID_CARD_WEIGHTS[index];
  }
  requireValue(
    ID_CARD_CHECK_CHARS[sum % 11] === raw[17],
    "身份证号校验位不正确，请核对后重新输入",
  );
  return raw;
}

// 手机号校验：只接受中国大陆 11 位手机号
function readPhoneNumber(value, label = "手机号") {
  const raw = String(value ?? "")
    .trim()
    .replace(/[\s-]/g, "");
  requireValue(/^1[3-9]\d{9}$/.test(raw), `${label}格式不正确，请输入 11 位手机号`);
  return raw;
}

// 接单员资料查询
function findAcceptorProfile(userId) {
  return get("SELECT * FROM acceptor_profiles WHERE user_id = ?", [userId]) || null;
}

// 接单资格门：接单接口与任务视图共用同一套判断，避免两处口径不一致。
// 判定条件集中在 status.js 的 isAcceptorActive()，即"审核通过 + 保证金在托管中"。
function acceptorGate(userId) {
  const profile = findAcceptorProfile(userId);
  const canAccept = isAcceptorActive(profile);
  return {
    profile,
    canAccept,
    blockedReason: canAccept ? "" : describeAcceptorBlocker(profile),
    summary: {
      required_deposit: ACCEPTOR_DEPOSIT_AMOUNT,
      status: profile ? Number(profile.status) : ACCEPTOR_STATUS.NONE,
      status_text:
        ACCEPTOR_STATUS_LABEL[profile ? Number(profile.status) : ACCEPTOR_STATUS.NONE],
      deposit_status: profile ? Number(profile.deposit_status) : DEPOSIT_STATUS.UNPAID,
      can_accept: canAccept,
      blocked_reason: canAccept ? "" : describeAcceptorBlocker(profile),
    },
  };
}

// 接单准入：这是"未认证用户只能发布任务、不能接单"这条业务规则的唯一执行点。
function assertAcceptorActive(userId) {
  const gate = acceptorGate(userId);
  if (!gate.canAccept) throw new HttpError(403, gate.blockedReason);
  return gate.profile;
}

// 破坏性操作（资金裁决、停用账号等）要求超级管理员身份。
// 修复此前 admins.role 仅在登录响应里回显、从不参与任何授权判断的问题。
function requireSuperAdmin(identity) {
  const admin = get("SELECT role FROM admins WHERE id = ?", [identity?.id]);
  if (!admin || Number(admin.role) < SUPER_ADMIN_ROLE) {
    throw new HttpError(403, "该操作需要超级管理员权限");
  }
}

// 校验管理员设置的任务状态是否合法。
// 修复此前 PUT /api/admin/tasks/:id/status 直接 Number(body.status) 落库、
// 既无枚举校验、也可把任务直接改成"已完成"从而绕过资金结算流程的问题。
function assertAssignableTaskStatus(status, taskId) {
  requireValue(
    TASK_STATUS_VALUES.includes(status),
    `任务状态必须是 ${TASK_STATUS_VALUES.join(" / ")} 之一`,
  );
  if (status === TASK_STATUS.COMPLETED) {
    const order = get("SELECT pay_status FROM orders WHERE task_id = ?", [taskId]);
    // 没有订单同样意味着钱还在托管中：发布任务时就已经从发布者余额扣款，
    // 尚未产生订单说明这笔钱还没有任何结算或退出去向。
    const escrowHeld = !order || Number(order.pay_status) === PAY_STATUS.ESCROW;
    if (escrowHeld) {
      throw new HttpError(
        409,
        "该任务资金仍在托管中，不能直接标记为已完成；请走确认完成或投诉裁决流程",
      );
    }
  }
}

// 读取订单资金当前所处的真实位置——这是裁决时唯一可信的判据。
//
// 修复背景（原审计问题 #11）：原实现用
//   moneyFrozen = [1, 2, 5].includes(order.status) && order.pay_status === 1
// 来判断"钱是否还在托管中"。对已完成订单（status = 3, pay_status = 2）该条件恒为 false，
// 于是代码跳过全部资金操作、却照样把订单改成"已取消 / 已退款"，
// 造成订单显示已退款、双方余额一分未动、钱包流水里也查不到这笔退款（账实不符）。
function readFundState(order) {
  const payStatus = Number(order?.pay_status);
  if (payStatus === PAY_STATUS.ESCROW) return "escrow"; // 仍在托管，未付给任何一方
  if (payStatus === PAY_STATUS.SETTLED) return "settled"; // 已结算给接单者
  if (payStatus === PAY_STATUS.REFUNDED) return "refunded"; // 已退回发布者
  return "unknown";
}

// 资金划转：改余额 + 记流水，两者永远成对出现。
// 扣回导致余额为负时直接抛错回滚整个裁决事务，
// 而不是"订单状态改了、钱没动"——宁可明确报错，也不产生账实不符。
function changeBalance(userId, delta, orderId, type, remark) {
  const user = get("SELECT balance FROM users WHERE id = ?", [userId]);
  if (!user) throw new HttpError(404, "资金划转失败：相关用户不存在");
  const balance = Number((Number(user.balance) + Number(delta)).toFixed(2));
  if (balance < 0) {
    throw new HttpError(
      409,
      "资金划转失败：对方余额不足以完成扣回。请先与双方线下协商，再作出裁决。",
    );
  }
  run("UPDATE users SET balance = ?, updated_at = ? WHERE id = ?", [balance, now(), userId]);
  run(
    `INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, orderId ?? null, type, Number(Number(delta).toFixed(2)), balance, remark],
  );
  return balance;
}

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
        req ? clientAddress(req) : "",
      ],
    );
  } catch (error) {
    console.warn("审计日志写入失败:", error.message);
  }
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
    // 模拟登录只对本机/局域网开放，公网请求必须携带真实微信 code 走 code2Session
    const session = await exchangeCodeForSession(body.code, body.deviceId, {
      allowMock: isTrustedDemoRequest(req),
    });
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
      acceptor_deposit: ACCEPTOR_DEPOSIT_AMOUNT,
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
    return ok(res, {
      list: rows.map((row) => taskView(row, viewerId, false, viewerCommunity, acceptorArg)),
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
    // 上传总量配额（原审计问题 #35）：原先只限"单文件 5MB + 60 次/分"，
    // 持续调用可以打满磁盘、拖垮整个服务。这里加一道目录总量兜底。
    const existing = fs.readdirSync(uploadDir);
    requireValue(existing.length < MAX_UPLOAD_FILES, "上传文件数量已达上限，请联系管理员清理");
    const usedBytes = existing.reduce((sum, name) => {
      try {
        return sum + fs.statSync(path.join(uploadDir, name)).size;
      } catch {
        return sum;
      }
    }, 0);
    requireValue(usedBytes + buffer.length <= MAX_UPLOAD_BYTES, "上传空间已满，请联系管理员清理");
    const fileName = `u${Date.now()}${crypto.randomInt(1000, 9999)}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
    logOperation(identity, "upload_image", "file", null, `${fileName}, ${buffer.length}B`, req);
    return ok(res, { url: `/uploads/${fileName}` }, "上传成功");
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
    return ok(
      res,
      taskView(ensureTask(result), userId, true, publisher?.community || ""),
      "任务已发布并完成费用托管",
    );
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (method === "GET" && taskMatch) {
    const id = Number(taskMatch[1]);
    const viewer = identity?.type === "user"
      ? get("SELECT community FROM users WHERE id = ?", [identity.id])
      : null;
    const gate = identity?.type === "user" ? acceptorGate(identity.id) : null;
    return ok(
      res,
      taskView(ensureTask(id), identity?.id, false, viewer?.community || "", {
        canAccept: Boolean(gate?.canAccept),
        blockedReason: gate?.blockedReason || "",
      }),
    );
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
    // 剥离 openid 后返回（原审计问题 #5：此前直接返回 SELECT * 整行）
    // 同时带上接单资格摘要，个人中心据此展示"已认证 / 去认证"入口
    const gate = acceptorGate(identity.id);
    return ok(res, { ...publicUser(user), stats, acceptor: gate.summary });
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
    return ok(res, publicUser(get("SELECT * FROM users WHERE id = ?", [identity.id])), "资料已更新");
  }

  if (method === "GET" && pathname === "/api/addresses") {
    return ok(
      res,
      all("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", [identity.id]),
    );
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
    return ok(res, orderView(ensureOrder(order.id)), "已开始服务");
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
    return ok(res, orderView(ensureOrder(order.id)), "完成凭证已提交");
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
    return ok(res, orderView(ensureOrder(order.id)), "订单已完成，报酬已结算");
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
    return ok(res, orderView(ensureOrder(order.id)), "订单已取消");
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
    const amount = readMoney(body.amount, { min: 1, max: 1000, label: "充值金额" });
    if (rechargeMode !== "mock") {
      throw new HttpError(501, "微信商户支付尚未配置，请先配置商户号和支付证书");
    }
    // 修复背景（原审计问题 #3）：模拟充值原本默认全开且不区分请求来源，
    // 部署到公网后任何人无需支付即可给自己账户加钱（实测余额 145 → 1145）。
    // 现在模拟充值只对本机 / 局域网开放，公网环境必须配置真实微信支付。
    if (!isTrustedDemoRequest(req)) {
      throw new HttpError(403, "模拟充值仅限本机或局域网使用；公网环境请配置真实微信支付");
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
    const amount = readMoney(body.amount, { min: 1, max: 1000, label: "提现金额" });
    if (withdrawMode !== "mock") {
      throw new HttpError(501, "微信企业付款尚未配置，请先配置商户号和支付证书");
    }
    // 同充值：模拟提现只对本机 / 局域网开放（原审计问题 #3）
    if (!isTrustedDemoRequest(req)) {
      throw new HttpError(403, "模拟提现仅限本机或局域网使用；公网环境请配置真实微信企业付款");
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

  // ------------------------------------------------------------ 接单员认证

  // 查询自己的接单员认证状态。未提交过申请时同样返回 200（status = 0），
  // 让前端不必区分"没有记录"和"状态是未认证"两种情况。
  if (method === "GET" && pathname === "/api/acceptor/profile") {
    const gate = acceptorGate(identity.id);
    return ok(res, {
      ...gate.summary,
      profile: acceptorView(gate.profile),
    });
  }

  // 提交 / 重新提交实名认证申请
  if (method === "POST" && pathname === "/api/acceptor/apply") {
    enforceRateLimit(req, "acceptor-apply", 10);
    const userId = Number(identity.id);
    const body = await parseBody(req);
    const realName = optionalText(body.realName, 32);
    requireValue(/^[\u4e00-\u9fa5·]{2,32}$/.test(realName), "真实姓名需填写 2 个字以上的中文姓名");
    const idCardNo = readIdCardNo(body.idCardNo);
    const phone = readPhoneNumber(body.phone, "联系手机号");
    const idCardFront = optionalText(body.idCardFront, 255);
    const idCardBack = optionalText(body.idCardBack, 255);
    requireValue(
      Boolean(idCardFront && idCardBack),
      "请上传身份证正面与反面照片，用于管理员核验",
    );
    const emergencyContact = optionalText(body.emergencyContact, 64);
    const current = findAcceptorProfile(userId);
    if (current) {
      const status = Number(current.status);
      if (status === ACCEPTOR_STATUS.ACTIVE) {
        throw new HttpError(409, "你已通过接单员认证，无需重复提交");
      }
      if (status === ACCEPTOR_STATUS.REVIEWING) {
        throw new HttpError(409, "实名认证正在审核中，请等待审核结果");
      }
    }
    // 同一身份证号只允许绑定一个账号：防止同一人开多个接单账号刷单、规避保证金
    const occupied = get("SELECT user_id FROM acceptor_profiles WHERE id_card_no = ?", [idCardNo]);
    if (occupied && Number(occupied.user_id) !== userId) {
      throw new HttpError(409, "该身份证号已绑定其他账号，如有疑问请联系社区管理员");
    }
    const user = get("SELECT nickname, community FROM users WHERE id = ?", [userId]);
    transaction(() => {
      if (current) {
        // 重新提交时清空上一次的审核结论与保证金状态
        run(
          `UPDATE acceptor_profiles SET
            real_name = ?, id_card_no = ?, id_card_front = ?, id_card_back = ?, phone = ?,
            community = ?, emergency_contact = ?, status = ?, review_note = '',
            reviewed_by = NULL, reviewed_at = NULL,
            deposit_amount = ?, deposit_status = ?, deposit_paid_at = NULL, deposit_refunded_at = NULL,
            applied_at = ?, updated_at = ?
           WHERE user_id = ?`,
          [
            realName,
            idCardNo,
            idCardFront,
            idCardBack,
            phone,
            optionalText(body.community, 100) || user?.community || "",
            emergencyContact,
            ACCEPTOR_STATUS.REVIEWING,
            ACCEPTOR_DEPOSIT_AMOUNT,
            DEPOSIT_STATUS.UNPAID,
            now(),
            now(),
            userId,
          ],
        );
      } else {
        run(
          `INSERT INTO acceptor_profiles
            (user_id, real_name, id_card_no, id_card_front, id_card_back, phone, community,
             emergency_contact, status, deposit_amount, deposit_status, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            realName,
            idCardNo,
            idCardFront,
            idCardBack,
            phone,
            optionalText(body.community, 100) || user?.community || "",
            emergencyContact,
            ACCEPTOR_STATUS.REVIEWING,
            ACCEPTOR_DEPOSIT_AMOUNT,
            DEPOSIT_STATUS.UNPAID,
            now(),
          ],
        );
      }
      createMessage(
        userId,
        "接单员认证已提交",
        `实名认证资料已提交，管理员审核通过后缴纳 ¥${ACCEPTOR_DEPOSIT_AMOUNT.toFixed(2)} 保证金即可开始接单。`,
        1,
      );
    });
    logOperation(identity, "submit_acceptor_apply", "acceptor", userId, `实名 ${realName}`, req);
    const gate = acceptorGate(userId);
    return ok(
      res,
      { ...gate.summary, profile: acceptorView(gate.profile) },
      "认证资料已提交，请等待管理员审核",
    );
  }

  // 缴纳保证金：从钱包余额扣除，钱进入平台托管，状态变为可接单
  if (method === "POST" && pathname === "/api/acceptor/deposit") {
    enforceRateLimit(req, "acceptor-deposit", 10);
    const userId = Number(identity.id);
    const current = findAcceptorProfile(userId);
    if (!current) throw new HttpError(409, "请先提交接单员实名认证申请");
    const currentStatus = Number(current.status);
    if (currentStatus === ACCEPTOR_STATUS.REVIEWING) {
      throw new HttpError(409, "实名认证正在审核中，通过后即可缴纳保证金");
    }
    if (currentStatus === ACCEPTOR_STATUS.REJECTED) {
      throw new HttpError(409, "实名认证未通过，请修改资料后重新提交");
    }
    if (isAcceptorActive(current)) {
      throw new HttpError(409, "你已缴纳保证金，无需重复缴纳");
    }
    let paid = 0;
    transaction(() => {
      // 事务内重新读取，避免与管理员审核、并发点击产生竞态
      const fresh = get("SELECT * FROM acceptor_profiles WHERE user_id = ?", [userId]);
      // 状态冲突统一返回 409（资源当前状态不允许该操作），
      // 与入参格式错误（400）区分开，前端才能给出不同的引导文案
      if (Number(fresh?.status) !== ACCEPTOR_STATUS.APPROVED) {
        throw new HttpError(409, "当前状态不能缴纳保证金，请先确认实名认证已通过");
      }
      if (Number(fresh.deposit_status) === DEPOSIT_STATUS.HELD) {
        throw new HttpError(409, "保证金已在托管中，无需重复缴纳");
      }
      const amount = ACCEPTOR_DEPOSIT_AMOUNT;
      const user = get("SELECT balance FROM users WHERE id = ?", [userId]);
      requireValue(
        Number(user.balance) >= amount,
        `保证金需 ¥${amount.toFixed(2)}，当前余额不足，请先充值`,
      );
      paid = changeBalance(
        userId,
        -amount,
        null,
        WALLET_TYPE.DEPOSIT,
        `接单员保证金缴纳 ¥${amount.toFixed(2)}`,
      );
      run(
        `UPDATE acceptor_profiles SET
          status = ?, deposit_amount = ?, deposit_status = ?, deposit_paid_at = ?, updated_at = ?
         WHERE user_id = ?`,
        [ACCEPTOR_STATUS.ACTIVE, amount, DEPOSIT_STATUS.HELD, now(), now(), userId],
      );
      createMessage(
        userId,
        "接单员认证已完成",
        `保证金 ¥${amount.toFixed(2)} 已缴纳，你现在可以在任务大厅接单了。`,
        1,
      );
    });
    logOperation(
      identity,
      "pay_acceptor_deposit",
      "acceptor",
      current.id,
      `¥${ACCEPTOR_DEPOSIT_AMOUNT}`,
      req,
    );
    const gate = acceptorGate(userId);
    return ok(
      res,
      { ...gate.summary, balance: paid, profile: acceptorView(gate.profile) },
      "保证金已缴纳，你现在可以接单了",
    );
  }

  // 退出接单员并退还保证金。
  // 前置条件：保证金确实处于托管中、且没有进行中的订单——
  // 否则会出现"退了钱却还有在途责任"的死角。
  if (method === "POST" && pathname === "/api/acceptor/quit") {
    enforceRateLimit(req, "acceptor-quit", 10);
    const userId = Number(identity.id);
    const current = findAcceptorProfile(userId);
    if (!isAcceptorActive(current)) {
      throw new HttpError(409, "你当前不是已认证的接单员");
    }
    const inFlight = get(
      "SELECT COUNT(*) AS total FROM orders WHERE acceptor_id = ? AND status IN (?, ?)",
      [userId, ORDER_STATUS.ACCEPTED, ORDER_STATUS.IN_SERVICE],
    ).total;
    if (Number(inFlight) > 0) {
      throw new HttpError(
        409,
        `你还有 ${inFlight} 个进行中的订单，请先完成后再退出接单员`,
      );
    }
    let refunded = 0;
    transaction(() => {
      const fresh = get("SELECT * FROM acceptor_profiles WHERE user_id = ?", [userId]);
      if (!isAcceptorActive(fresh)) {
        throw new HttpError(409, "你当前不是已认证的接单员");
      }
      const amount = Number(fresh.deposit_amount || 0);
      if (amount > 0) {
        refunded = changeBalance(
          userId,
          amount,
          null,
          WALLET_TYPE.DEPOSIT_REFUND,
          `接单员保证金退还 ¥${amount.toFixed(2)}`,
        );
      }
      run(
        `UPDATE acceptor_profiles SET
          status = ?, deposit_status = ?, deposit_refunded_at = ?, updated_at = ?
         WHERE user_id = ?`,
        [ACCEPTOR_STATUS.QUIT, DEPOSIT_STATUS.REFUNDED, now(), now(), userId],
      );
      createMessage(
        userId,
        "已退出接单员",
        amount > 0
          ? `保证金 ¥${amount.toFixed(2)} 已退回你的钱包余额，再次接单需重新完成认证。`
          : "你已退出接单员，再次接单需重新完成认证。",
        1,
      );
    });
    logOperation(identity, "quit_acceptor", "acceptor", current.id, "退出并退还保证金", req);
    const gate = acceptorGate(userId);
    return ok(
      res,
      { ...gate.summary, balance: refunded, profile: acceptorView(gate.profile) },
      "已退出接单员，保证金已退回余额",
    );
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
    return ok(res, {
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
    return ok(res, { list, total, page, pageSize });
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
    return ok(res, null, "投诉已处理");
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
    return ok(res, { list, total, page, pageSize, summary });
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
    return ok(
      res,
      {
        id_card_no: profile.id_card_no,
        id_card_masked: maskIdCard(profile.id_card_no),
      },
      "已记录本次查看行为",
    );
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
    return ok(
      res,
      acceptorView(get("SELECT * FROM acceptor_profiles WHERE id = ?", [profile.id])),
      approved ? "已通过实名认证" : "已驳回认证申请",
    );
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
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // 形如 /%zz 的非法编码此前会让 decodeURIComponent 抛错并返回 500
    res.writeHead(400);
    return res.end("Bad Request");
  }
  if (pathname.includes("\0")) {
    res.writeHead(400);
    return res.end("Bad Request");
  }
  if (pathname === "/") {
    res.writeHead(302, { Location: "/preview/" });
    return res.end();
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  // 路径边界校验（原审计问题 #8）：原先用 target.startsWith(PUBLIC_DIR)，
  // 缺少路径分隔符边界，public 的兄弟目录（如 public-backup）会被误判为"位于 public 内"
  // 而被越权读取。改用 path.relative 判断目标是否真的落在 PUBLIC_DIR 之下。
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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
  // CORS 来源在此一次性判定（原审计问题 #9：此前所有响应统一 Access-Control-Allow-Origin: *），
  // 由 sendJson 按 res.corsOrigin 决定是否下发 CORS 头
  res.corsOrigin = resolveCorsOrigin(req);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendJson(res, 400, { code: 400, msg: "请求地址无效", data: null });
  }
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
  console.log(`JWT 密钥来源: ${SECRET_SOURCE}`);
  if (isMockLoginEnabled()) {
    console.warn("微信登录当前为本地模拟模式");
    console.warn("模拟登录与模拟充值仅对本机/局域网开放，来自公网的请求会被拒绝");
    console.warn("正式部署请按 docs/DEPLOYMENT.md 配置微信小程序密钥与 JWT_SECRET");
  } else {
    console.log(`微信登录: ${isWeChatConfigured() ? "code2Session 正式模式" : "等待配置"}`);
  }
  if (HOST === "0.0.0.0") {
    console.log("监听地址: 0.0.0.0（局域网内可访问，用于手机真机演示）；如需仅本机可访问请设置 HOST=127.0.0.1");
  }
});
