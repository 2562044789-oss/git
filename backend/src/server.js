const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SECRET_SOURCE, verifyToken } = require("./auth");
const { db, get, now, run } = require("./db");
const {
  HttpError,
  fail,
  ok,
  optionalText,
  requireValue,
  resolveCorsOrigin,
  sendJson,
} = require("./http");
const { clientAddress } = require("./network");
const {
  ACCEPTOR_STATUS,
  ACCEPTOR_STATUS_LABEL,
  DEPOSIT_STATUS,
  PAY_STATUS,
  TASK_STATUS,
  TASK_STATUS_VALUES,
  describeAcceptorBlocker,
  isAcceptorActive,
} = require("./status");
const {
  isMockLoginEnabled,
  isWeChatConfigured,
  validateWeChatConfiguration,
} = require("./wechat");
// 领域路由：按业务域从 handleApi 拆出。每个文件导出 async (req, res, url, ctx) => boolean，
// 匹配到本域路由就处理并返回 true，否则返回 false 交给下一个域。
const handleAcceptor = require("./routes/acceptor");
const handleAdmin = require("./routes/admin");
const handleAuth = require("./routes/auth");
const handleComplaints = require("./routes/complaints");
const handleMessages = require("./routes/messages");
const handleOrders = require("./routes/orders");
const handlePublic = require("./routes/public");
const handleReviews = require("./routes/reviews");
const handleTasks = require("./routes/tasks");
const handleUpload = require("./routes/upload");
const handleUser = require("./routes/user");
const handleWallet = require("./routes/wallet");

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

  // 注入给领域路由的上下文：身份（鉴权后回填）、环境开关、以及上面的业务 helper。
  // routes/*.js 只 import db/http/views/status 等基础模块，不反向引用本文件。
  const ctx = {
    method,
    pathname,
    identity: null,
    authenticate,
    pickText,
    readIdCardNo,
    readPhoneNumber,
    findAcceptorProfile,
    acceptorGate,
    assertAcceptorActive,
    requireSuperAdmin,
    assertAssignableTaskStatus,
    readFundState,
    changeBalance,
    logOperation,
    ensureTask,
    ensureOrder,
    canViewOrder,
    createMessage,
    createOrderNumber,
    buildTaskWhere,
    serviceFeeRate,
    rechargeMode,
    withdrawMode,
    ACCEPTOR_DEPOSIT_AMOUNT,
    MAX_CREDIT_SCORE,
    MIN_CREDIT_TO_TRADE,
    MAX_UPLOAD_FILES,
    MAX_UPLOAD_BYTES,
    SUPER_ADMIN_ROLE,
    PUBLIC_DIR,
  };

  // 登录类接口无需鉴权，在统一鉴权之前先分发
  if (await handleAuth(req, res, url, ctx)) return;

  // 公开路径：无需登录即可访问。
  // 公告列表/详情也要公开 —— 小程序首页在登录前就会渲染公告条，
  // 若强制鉴权，未登录用户会看到一个空白的公告区。
  const isPublicAnnouncement =
    pathname === "/api/announcements" || /^\/api\/announcements\/\d+$/.test(pathname);
  const publicPaths =
    method === "GET" &&
    (["/api/config", "/api/categories", "/api/tasks"].includes(pathname) ||
      isPublicAnnouncement);
  let identity = null;
  if (!publicPaths) {
    identity = authenticate(req, pathname.startsWith("/api/admin/"));
  } else if (req.headers.authorization) {
    identity = verifyToken(req.headers.authorization.replace("Bearer ", ""));
  }
  ctx.identity = identity;

  // 领域路由依次分发；handler 返回 false 表示未匹配，继续下一个。
  // 新增领域时：在 routes/ 下加文件、在上面 require、在这里注册，共三步。
  const domainHandlers = [
    handlePublic,
    handleUpload,
    handleUser,
    handleWallet,
    handleAcceptor,
    handleMessages,
    handleReviews,
    handleComplaints,
    handleTasks,
    handleOrders,
    handleAdmin,
  ];
  for (const handler of domainHandlers) {
    if (await handler(req, res, url, ctx)) return;
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
