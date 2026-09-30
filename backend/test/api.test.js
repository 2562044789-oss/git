// 端到端接口测试：真实启动后端进程 + 临时数据库，覆盖资金托管与订单状态机。
//
// 背景（原审计问题 #33）：修复前测试只有 4 个用例，且全部在测 wechat.js 的模拟登录，
// 订单状态机、资金托管、并发接单这些最该测的核心逻辑零覆盖——
// 而恰恰是这些地方出现了"账实不符""任务永久卡在争议态"的真实缺陷。
//
// 本文件不触碰项目数据库：通过 DATABASE_PATH 指向临时目录，
// 并在结束时不残留任何数据。

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.TEST_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sunshine-test-"));
const dbPath = path.join(dataDir, "test.sqlite");

let serverProcess = null;
let serverLog = "";

function query(sql, params = []) {
  const connection = new DatabaseSync(dbPath);
  try {
    return connection.prepare(sql).all(...params);
  } finally {
    connection.close();
  }
}

function queryOne(sql, params = []) {
  return query(sql, params)[0] || null;
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/config`);
      if (response.ok) return;
    } catch {
      // 服务尚未就绪，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`后端未能在 ${timeoutMs}ms 内启动。服务日志：\n${serverLog}`);
}

async function api(method, pathname, { token, body, headers } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload, response };
}

async function login(code) {
  const result = await api("POST", "/api/auth/login", { body: { code } });
  assert.equal(result.status, 200, `登录失败：${JSON.stringify(result.body)}`);
  return result.body.data;
}

async function loginAdmin() {
  const result = await api("POST", "/api/admin/login", {
    body: { username: "admin", password: "admin123" },
  });
  assert.equal(result.status, 200);
  return result.body.data.token;
}

// 新建一个余额充足的测试用户（模拟登录 + 模拟充值），避免依赖种子余额
let userSeq = 0;
async function createFundedUser(amount = 200) {
  userSeq += 1;
  const session = await login(`test-user-${Date.now()}-${userSeq}`);
  if (amount > 0) {
    const recharge = await api("POST", "/api/wallet/recharge", {
      token: session.token,
      body: { amount },
    });
    assert.equal(recharge.status, 200, `充值失败：${JSON.stringify(recharge.body)}`);
  }
  return session;
}

function balanceOf(userId) {
  return Number(queryOne("SELECT balance FROM users WHERE id = ?", [userId]).balance);
}

// 生成符合 GB 11643-1999 校验规则的 18 位身份证号。
// 前 17 位固定为行政区划 + 出生日期 + 自增顺序码（保证唯一），
// 最后一位按加权校验和计算，确保能通过后端 readIdCardNo 的格式与校验位检查。
// 行政区划/生日刻意避开种子数据（110101/320102 段），否则会撞上唯一索引。
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CHARS = "10X98765432";
let idCardSeq = 0;
function makeIdCardNo() {
  idCardSeq += 1;
  const prefix = `44030519880101${String(idCardSeq).padStart(3, "0")}`;
  const sum = [...prefix].reduce(
    (total, char, index) => total + Number(char) * ID_CARD_WEIGHTS[index],
    0,
  );
  return `${prefix}${ID_CARD_CHECK_CHARS[sum % 11]}`;
}

// 把已登录用户升级为"审核通过 + 保证金托管中"的合格接单员。
// 接单门槛上线后，凡是要真正接单的测试都必须先走完 申请 → 审核 → 缴费 三步。
async function certifyAcceptor(
  session,
  adminToken,
  { realName = "测试接单员", idCardNo, phone } = {},
) {
  const contactPhone = phone || `1380000${String(idCardSeq).padStart(4, "0")}`;
  const applied = await api("POST", "/api/acceptor/apply", {
    token: session.token,
    body: {
      realName,
      idCardNo: idCardNo || makeIdCardNo(),
      phone: contactPhone,
      idCardFront: "/uploads/test-id-front.png",
      idCardBack: "/uploads/test-id-back.png",
    },
  });
  assert.equal(applied.status, 200, `认证申请失败：${JSON.stringify(applied.body)}`);
  const profileId = applied.body.data.profile.id;

  const reviewed = await api("PUT", `/api/admin/acceptor-profiles/${profileId}/review`, {
    token: adminToken,
    body: { approved: true },
  });
  assert.equal(reviewed.status, 200, `审核认证失败：${JSON.stringify(reviewed.body)}`);

  const paid = await api("POST", "/api/acceptor/deposit", { token: session.token });
  assert.equal(paid.status, 200, `缴纳保证金失败：${JSON.stringify(paid.body)}`);
  return profileId;
}

// 一步创建"已认证 + 已缴保证金"的接单员：充值 amount 后扣掉 50 元保证金
async function createCertifiedAcceptor(amount = 200) {
  const session = await createFundedUser(amount);
  const adminToken = await loginAdmin();
  await certifyAcceptor(session, adminToken);
  return session;
}

// 把一条任务从发布一路推进到"已完成并结算"，返回相关标识
async function completeAnOrder(publisher, acceptor, reward = 12) {
  const published = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: {
      categoryId: 1,
      title: "自动化测试任务：代取快递",
      description: "端到端测试用任务",
      pickupAddress: "阳光社区东门",
      deliveryAddress: "阳光社区9栋",
      reward,
    },
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const taskId = published.body.data.id;

  const accepted = await api("POST", `/api/tasks/${taskId}/accept`, { token: acceptor.token });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const orderId = accepted.body.data.id;

  const started = await api("POST", `/api/orders/${orderId}/start`, { token: acceptor.token });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const finished = await api("POST", `/api/orders/${orderId}/finish`, {
    token: acceptor.token,
    body: { images: ["/uploads/test-proof.png"] },
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));

  const confirmed = await api("POST", `/api/orders/${orderId}/confirm`, { token: publisher.token });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  return { taskId, orderId };
}

test.before(async () => {
  serverProcess = spawn(
    process.execPath,
    ["--no-warnings", path.join(__dirname, "..", "src", "server.js")],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        DATABASE_PATH: dbPath,
        WECHAT_MOCK_LOGIN: "1",
        JWT_SECRET: "",
        NODE_ENV: "",
        // 测试会在几秒内反复调用登录/充值/认证接口，必然触发按分钟计的限流；
        // 这里显式关掉限流，生产环境不设置该变量，防护行为不受影响。
        RATE_LIMIT_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProcess.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  await waitForServer();
});

test.after(() => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 安全

test("用源码中公开的默认密钥伪造管理员令牌会被拒绝", async () => {
  const encode = (value) => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encode(
    JSON.stringify({ id: 1, type: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  const signature = crypto
    .createHmac("sha256", "sunshine-community-dev-secret")
    .update(`${header}.${payload}`)
    .digest("base64url");
  const result = await api("GET", "/api/admin/users", {
    token: `${header}.${payload}.${signature}`,
  });
  assert.equal(result.status, 401, "伪造的管理员令牌不应通过校验");
});

test("本机来源仍可使用模拟登录，且不再返回 openid", async () => {
  const session = await login("demo-user");
  assert.equal(session.login_mode, "mock");
  assert.equal(session.user.nickname, "林小满");
  assert.equal("openid" in session.user, false, "登录响应不应包含 openid");
});

test("带反向代理转发头的请求不能使用模拟登录", async () => {
  const result = await api("POST", "/api/auth/login", {
    body: { code: "demo-user" },
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(result.status, 403, "公网来源不得使用模拟登录后门");
});

test("带反向代理转发头的请求不能使用模拟充值", async () => {
  const session = await login("demo-user");
  const result = await api("POST", "/api/wallet/recharge", {
    token: session.token,
    body: { amount: 1000 },
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(result.status, 403, "公网来源不得无限充值");
});

test("用户资料与后台用户列表均不返回 openid", async () => {
  const session = await login("demo-user");
  const profile = await api("GET", "/api/user/profile", { token: session.token });
  assert.equal(profile.status, 200);
  assert.equal("openid" in profile.body.data, false, "个人资料不应包含 openid");

  const admin = await loginAdmin();
  const users = await api("GET", "/api/admin/users?pageSize=50", { token: admin });
  assert.equal(users.status, 200);
  assert.ok(Array.isArray(users.body.data.list), "后台用户列表应返回分页结构");
  assert.equal(
    users.body.data.list.some((item) => "openid" in item),
    false,
    "后台用户列表不应包含 openid",
  );
  assert.ok(Number(users.body.data.total) > 0);
});

test("跨站来源不再获得通配 CORS 头，本机开发来源仍放行", async () => {
  const evil = await api("GET", "/api/config", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.response.headers.get("access-control-allow-origin"), null);

  const local = await api("GET", "/api/config", { headers: { Origin: "http://localhost:5173" } });
  assert.equal(
    local.response.headers.get("access-control-allow-origin"),
    "http://localhost:5173",
  );
});

test("静态资源的路径边界校验能挡住目录穿越", async () => {
  const result = await api("GET", "/%2e%2e/package.json");
  assert.notEqual(result.status, 200, "不应能读取 public 目录之外的文件");
});

// ---------------------------------------------------------------- 输入校验

test("非法分页参数返回 200，不再触发 500", async () => {
  const session = await login("demo-user");
  for (const search of ["?page=abc", "?page=-5", "?pageSize=abc", "?page=0"]) {
    const tasks = await api("GET", `/api/tasks${search}`);
    assert.equal(tasks.status, 200, `/api/tasks${search} 返回了 ${tasks.status}`);
    assert.equal(tasks.body.data.page, 1);

    const orders = await api("GET", `/api/orders${search}`, { token: session.token });
    assert.equal(orders.status, 200, `/api/orders${search} 返回了 ${orders.status}`);
  }
});

test("报酬金额超过两位小数会被拒绝", async () => {
  const publisher = await createFundedUser();
  const result = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "测试非法金额的任务", reward: 1.005 },
  });
  assert.equal(result.status, 400);
});

test("改资料与新增地址的长度会被截断，不会原样落库", async () => {
  const session = await login("demo-user");
  const longName = "超".repeat(200);
  const updated = await api("PUT", "/api/user/profile", {
    token: session.token,
    body: { nickname: longName },
  });
  assert.equal(updated.status, 200);
  assert.ok(updated.body.data.nickname.length <= 32, "昵称应被截断到 32 字以内");
  assert.equal("openid" in updated.body.data, false);
});

// ---------------------------------------------------------------- 资金与状态机

test("完整履约链路：托管 → 接单 → 交凭证 → 确认结算，余额逐笔对账", async () => {
  const publisher = await createFundedUser(200);
  const acceptor = await createCertifiedAcceptor(200);
  const reward = 12;

  const publisherBefore = balanceOf(publisher.user.id);
  const acceptorBefore = balanceOf(acceptor.user.id);

  const { orderId, taskId } = await completeAnOrder(publisher, acceptor, reward);

  assert.equal(balanceOf(publisher.user.id), publisherBefore - reward, "发布者应被扣除托管款");
  assert.equal(balanceOf(acceptor.user.id), acceptorBefore + reward, "接单者应收到报酬");

  const order = queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  assert.equal(Number(order.status), 3, "订单应为已完成");
  assert.equal(Number(order.pay_status), 2, "订单应为已结算");
  assert.equal(Number(queryOne("SELECT status FROM tasks WHERE id = ?", [taskId]).status), 4);

  const wallet = query("SELECT * FROM wallet_records WHERE user_id = ? ORDER BY id", [
    acceptor.user.id,
  ]);
  const settlement = wallet.find((row) => Number(row.type) === 1);
  assert.ok(settlement, "接单者应有结算流水");
  assert.equal(Number(settlement.amount), reward);
  assert.equal(Number(settlement.balance), balanceOf(acceptor.user.id), "流水余额应与账户余额一致");
});

test("已完成订单裁决退款：必须真实扣回并退款，且状态与资金一致", async () => {
  const publisher = await createFundedUser(200);
  const acceptor = await createCertifiedAcceptor(200);
  const reward = 12;

  const { orderId, taskId } = await completeAnOrder(publisher, acceptor, reward);
  const publisherAfterSettle = balanceOf(publisher.user.id);
  const acceptorAfterSettle = balanceOf(acceptor.user.id);

  const complaint = await api("POST", "/api/complaints", {
    token: acceptor.token,
    body: { orderId, reason: "未按约定送达", description: "自动化测试投诉" },
  });
  assert.equal(complaint.status, 200, JSON.stringify(complaint.body));
  const complaintId = complaint.body.data.id;

  const admin = await loginAdmin();
  const verdict = await api("PUT", `/api/admin/complaints/${complaintId}`, {
    token: admin,
    body: { verdict: "refund", handleResult: "测试裁决：退款给发布者" },
  });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));

  // 关键断言：钱真的动了，而且两边都对
  assert.equal(
    balanceOf(acceptor.user.id),
    acceptorAfterSettle - reward,
    "已结算的报酬应被扣回",
  );
  assert.equal(
    balanceOf(publisher.user.id),
    publisherAfterSettle + reward,
    "托管款应退回发布者",
  );

  const order = queryOne("SELECT * FROM orders WHERE id = ?", [orderId]);
  assert.equal(Number(order.status), 4, "订单应为已取消");
  assert.equal(Number(order.pay_status), 3, "订单应为已退款");

  const task = queryOne("SELECT * FROM tasks WHERE id = ?", [taskId]);
  assert.equal(Number(task.status), 5, "任务应为已取消");

  // 账实相符：钱包流水中必须能找到这两笔
  const walletRecords = query(
    "SELECT * FROM wallet_records WHERE order_id = ? ORDER BY id",
    [orderId],
  );
  assert.ok(
    walletRecords.some((row) => Number(row.type) === 2 && Number(row.amount) === -reward),
    "应有接单者的扣回流水",
  );
  assert.ok(
    walletRecords.some((row) => Number(row.type) === 3 && Number(row.amount) === reward),
    "应有发布者的退款流水",
  );
});

test("裁决驳回后任务状态会被恢复，不会永久卡在争议中", async () => {
  const publisher = await createFundedUser(200);
  const acceptor = await createCertifiedAcceptor(200);

  const { orderId, taskId } = await completeAnOrder(publisher, acceptor, 10);

  const complaint = await api("POST", "/api/complaints", {
    token: publisher.token,
    body: { orderId, reason: "服务与描述不符", description: "自动化测试投诉" },
  });
  assert.equal(complaint.status, 200);
  assert.equal(
    Number(queryOne("SELECT status FROM tasks WHERE id = ?", [taskId]).status),
    6,
    "投诉后任务应进入争议中",
  );

  const admin = await loginAdmin();
  const verdict = await api("PUT", `/api/admin/complaints/${complaint.body.data.id}`, {
    token: admin,
    body: { verdict: "reject", handleResult: "测试裁决：驳回" },
  });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body));

  // 关键断言：任务不能永久停留在 6
  assert.equal(
    Number(queryOne("SELECT status FROM tasks WHERE id = ?", [taskId]).status),
    4,
    "驳回后任务应恢复为已完成，而不是卡在争议中",
  );
  assert.equal(Number(queryOne("SELECT status FROM orders WHERE id = ?", [orderId]).status), 3);
});

test("同一订单不能重复提交未处理的投诉", async () => {
  const publisher = await createFundedUser(200);
  const acceptor = await createCertifiedAcceptor(200);
  const { orderId } = await completeAnOrder(publisher, acceptor, 8);

  const first = await api("POST", "/api/complaints", {
    token: acceptor.token,
    body: { orderId, reason: "第一次投诉" },
  });
  assert.equal(first.status, 200);

  const second = await api("POST", "/api/complaints", {
    token: acceptor.token,
    body: { orderId, reason: "重复投诉" },
  });
  assert.equal(second.status, 409, "未处理完的投诉不应允许重复提交");
});

test("并发接单只有一个能成功", async () => {
  const publisher = await createFundedUser(200);
  const [first, second, third] = await Promise.all([
    createCertifiedAcceptor(200),
    createCertifiedAcceptor(200),
    createCertifiedAcceptor(200),
  ]);

  const published = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "并发接单测试任务", reward: 10 },
  });
  const taskId = published.body.data.id;

  const results = await Promise.all(
    [first, second, third].map((acceptor) =>
      api("POST", `/api/tasks/${taskId}/accept`, { token: acceptor.token }),
    ),
  );
  const succeeded = results.filter((item) => item.status === 200);
  assert.equal(succeeded.length, 1, `应只有 1 人接单成功，实际 ${succeeded.length} 人`);
  assert.equal(
    query("SELECT * FROM orders WHERE task_id = ?", [taskId]).length,
    1,
    "同一任务不应产生多张订单",
  );
});

// ---------------------------------------------------------------- 后台权限与枚举

test("管理员不能把资金仍在托管中的任务直接标记为已完成", async () => {
  const publisher = await createFundedUser(200);
  const published = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "后台越权改状态测试", reward: 10 },
  });
  const taskId = published.body.data.id;
  const admin = await loginAdmin();

  const bypass = await api("PUT", `/api/admin/tasks/${taskId}/status`, {
    token: admin,
    body: { status: 4 },
  });
  assert.equal(bypass.status, 409, "托管中的任务不应能被直接改成已完成");

  const illegal = await api("PUT", `/api/admin/tasks/${taskId}/status`, {
    token: admin,
    body: { status: 99 },
  });
  assert.equal(illegal.status, 400, "非法状态值应被拒绝");

  const legal = await api("PUT", `/api/admin/tasks/${taskId}/status`, {
    token: admin,
    body: { status: 5 },
  });
  assert.equal(legal.status, 200, "合法状态（下架）应放行");
});

test("非超级管理员不能执行资金裁决与用户管理", async () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("normal123", salt, 64).toString("hex");
  const connection = new DatabaseSync(dbPath);
  connection
    .prepare(
      "INSERT INTO admins (username, password_hash, real_name, role, status) VALUES (?, ?, ?, 1, 1)",
    )
    .run("normal-admin", `${salt}:${hash}`, "普通管理员");
  connection.close();

  const login = await api("POST", "/api/admin/login", {
    body: { username: "normal-admin", password: "normal123" },
  });
  assert.equal(login.status, 200);
  const token = login.body.data.token;

  const users = await api("GET", "/api/admin/users", { token });
  assert.equal(users.status, 403, "普通管理员不应能查看全量用户");

  const dashboard = await api("GET", "/api/admin/dashboard", { token });
  assert.equal(dashboard.status, 200, "普通管理员仍可看仪表盘");
});

test("信用分低于门槛的用户不能发布任务", async () => {
  const publisher = await createFundedUser(200);
  const connection = new DatabaseSync(dbPath);
  connection
    .prepare("UPDATE users SET credit_score = 10 WHERE id = ?")
    .run(publisher.user.id);
  connection.close();

  const result = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "低信用分发布测试", reward: 10 },
  });
  assert.equal(result.status, 400, "信用分不足应被拦截");
});

// ---------------------------------------------------------------- 接单员认证与接单门槛

test("未认证用户只能发布任务，不能接单，且能拿到不可接单的具体原因", async () => {
  const publisher = await createFundedUser(200);
  const stranger = await createFundedUser(200); // 有余额但未提交任何认证资料

  const published = await api("POST", "/api/tasks", {
    token: stranger.token,
    body: { categoryId: 1, title: "未认证用户发布任务", reward: 10 },
  });
  assert.equal(published.status, 200, "未认证用户发布任务应被允许");
  assert.equal(published.body.data.status, 0);

  const target = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "未认证用户尝试接单", reward: 10 },
  });
  const taskId = target.body.data.id;

  const accepted = await api("POST", `/api/tasks/${taskId}/accept`, { token: stranger.token });
  assert.equal(accepted.status, 403, "未通过认证门槛不能接单");
  assert.match(accepted.body.msg, /认证|保证金/, "拦截提示应说明缺少哪一步");

  // 任务详情也要提前给出"不可接单"的原因，避免用户点下去才收到报错
  const detail = await api("GET", `/api/tasks/${taskId}`, { token: stranger.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.can_accept, false);
  assert.ok(detail.body.data.accept_blocked_reason, "应返回不可接单的具体原因");
});

test("身份证号会校验位数、出生日期与校验位", async () => {
  const user = await createFundedUser(0);
  const submit = (idCardNo) =>
    api("POST", "/api/acceptor/apply", {
      token: user.token,
      body: {
        realName: "张三",
        idCardNo,
        phone: "13800138000",
        idCardFront: "/uploads/f.png",
        idCardBack: "/uploads/b.png",
      },
    });

  assert.equal((await submit("11010119900315001")).status, 400, "位数不足应被拒绝");
  assert.equal((await submit("110101199002300011")).status, 400, "不存在的出生日期应被拒绝");
  assert.equal((await submit("110101199003150010")).status, 400, "校验位错误应被拒绝");

  // 缺手机号 / 缺证件照片同样要拦住
  const noPhoto = await api("POST", "/api/acceptor/apply", {
    token: user.token,
    body: { realName: "张三", idCardNo: makeIdCardNo(), phone: "13800138000" },
  });
  assert.equal(noPhoto.status, 400, "缺少身份证照片应被拒绝");

  const good = await submit(makeIdCardNo());
  assert.equal(good.status, 200, `合法身份证号应通过：${JSON.stringify(good.body)}`);
  assert.ok(good.body.data.profile.id_card_masked.includes("*"), "返回的号码必须是脱敏形式");
});

test("认证流程：申请 → 审核 → 缴保证金 → 可接单，保证金扣款账目一致", async () => {
  const adminToken = await loginAdmin();
  const acceptor = await createFundedUser(200);
  const beforeDeposit = balanceOf(acceptor.user.id);

  await certifyAcceptor(acceptor, adminToken);
  assert.equal(balanceOf(acceptor.user.id), beforeDeposit - 50, "保证金应从钱包余额扣除");

  const depositRecord = queryOne(
    "SELECT * FROM wallet_records WHERE user_id = ? AND type = 6 ORDER BY id DESC",
    [acceptor.user.id],
  );
  assert.ok(depositRecord, "应有保证金缴纳流水");
  assert.equal(Number(depositRecord.amount), -50);
  assert.equal(
    Number(depositRecord.balance),
    balanceOf(acceptor.user.id),
    "保证金流水余额应与账户余额一致",
  );

  // 认证通过后真正可以接单
  const publisher = await createFundedUser(200);
  const published = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "已认证接单员接单测试", reward: 10 },
  });
  const accepted = await api("POST", `/api/tasks/${published.body.data.id}/accept`, {
    token: acceptor.token,
  });
  assert.equal(accepted.status, 200, `已认证并缴纳保证金后应能接单：${JSON.stringify(accepted.body)}`);

  // 认证资料接口不得返回完整身份证号
  const info = await api("GET", "/api/acceptor/profile", { token: acceptor.token });
  assert.equal(info.status, 200);
  assert.equal(info.body.data.can_accept, true);
  assert.equal(info.body.data.profile.id_card_no, undefined, "不应返回完整身份证号");
  assert.ok(info.body.data.profile.id_card_masked.includes("*"), "应返回脱敏身份证号");
});

test("同一身份证号只能绑定一个账号，保证金不能重复缴纳", async () => {
  const adminToken = await loginAdmin();
  const idCardNo = makeIdCardNo();

  const first = await createFundedUser(200);
  await certifyAcceptor(first, adminToken, { idCardNo });

  const again = await api("POST", "/api/acceptor/deposit", { token: first.token });
  assert.equal(again.status, 409, "已缴保证金不应允许重复缴纳");

  const second = await createFundedUser(200);
  const conflict = await api("POST", "/api/acceptor/apply", {
    token: second.token,
    body: {
      realName: "李四",
      idCardNo,
      phone: "13800138001",
      idCardFront: "/uploads/f.png",
      idCardBack: "/uploads/b.png",
    },
  });
  assert.equal(conflict.status, 409, "同一身份证号不能绑定第二个账号");
});

test("有进行中订单时不能退出接单员，结清后退出并退还保证金", async () => {
  const adminToken = await loginAdmin();
  const publisher = await createFundedUser(200);
  const acceptor = await createFundedUser(200);
  await certifyAcceptor(acceptor, adminToken);
  const afterCertify = balanceOf(acceptor.user.id);

  const published = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "退出接单员前置检查", reward: 10 },
  });
  const accepted = await api("POST", `/api/tasks/${published.body.data.id}/accept`, {
    token: acceptor.token,
  });
  assert.equal(accepted.status, 200);
  const orderId = accepted.body.data.id;

  const blocked = await api("POST", "/api/acceptor/quit", { token: acceptor.token });
  assert.equal(blocked.status, 409, "有进行中订单时不应允许退出");

  await api("POST", `/api/orders/${orderId}/start`, { token: acceptor.token });
  await api("POST", `/api/orders/${orderId}/finish`, {
    token: acceptor.token,
    body: { images: ["/uploads/test-proof.png"] },
  });
  await api("POST", `/api/orders/${orderId}/confirm`, { token: publisher.token });

  const quit = await api("POST", "/api/acceptor/quit", { token: acceptor.token });
  assert.equal(quit.status, 200, `结清订单后应可退出：${JSON.stringify(quit.body)}`);
  assert.equal(
    balanceOf(acceptor.user.id),
    afterCertify + 10 + 50,
    "退出后保证金应退回，已完成订单的报酬也已结算",
  );

  const refundRecord = queryOne(
    "SELECT * FROM wallet_records WHERE user_id = ? AND type = 7 ORDER BY id DESC",
    [acceptor.user.id],
  );
  assert.ok(refundRecord, "应有保证金退还流水");
  assert.equal(Number(refundRecord.amount), 50);

  // 退出后失去接单资格，但依然可以发布任务
  const target = await api("POST", "/api/tasks", {
    token: publisher.token,
    body: { categoryId: 1, title: "退出后不可接单检查", reward: 10 },
  });
  const rejected = await api("POST", `/api/tasks/${target.body.data.id}/accept`, {
    token: acceptor.token,
  });
  assert.equal(rejected.status, 403, "退出接单员后不能接单");

  const publishAgain = await api("POST", "/api/tasks", {
    token: acceptor.token,
    body: { categoryId: 1, title: "退出后仍可发布任务", reward: 10 },
  });
  assert.equal(publishAgain.status, 200, "退出接单员不影响发布任务");
});

test("接单员认证的审核与身份证查看受超级管理员权限约束，且查看留痕", async () => {
  const applicant = await createFundedUser(200);
  const applied = await api("POST", "/api/acceptor/apply", {
    token: applicant.token,
    body: {
      realName: "王五",
      idCardNo: makeIdCardNo(),
      phone: "13800138002",
      idCardFront: "/uploads/f.png",
      idCardBack: "/uploads/b.png",
    },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const profileId = applied.body.data.profile.id;

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("normal456", salt, 64).toString("hex");
  const connection = new DatabaseSync(dbPath);
  connection
    .prepare(
      "INSERT INTO admins (username, password_hash, real_name, role, status) VALUES (?, ?, ?, 1, 1)",
    )
    .run("acceptor-normal-admin", `${salt}:${hash}`, "普通管理员");
  connection.close();

  const normalLogin = await api("POST", "/api/admin/login", {
    body: { username: "acceptor-normal-admin", password: "normal456" },
  });
  const normalToken = normalLogin.body.data.token;

  assert.equal(
    (await api("GET", "/api/admin/acceptor-profiles", { token: normalToken })).status,
    403,
    "普通管理员不应能查看接单员认证列表",
  );
  assert.equal(
    (
      await api("GET", `/api/admin/acceptor-profiles/${profileId}/id-card`, {
        token: normalToken,
      })
    ).status,
    403,
    "普通管理员不应能查看完整身份证号",
  );
  assert.equal(
    (
      await api("PUT", `/api/admin/acceptor-profiles/${profileId}/review`, {
        token: normalToken,
        body: { approved: true },
      })
    ).status,
    403,
    "普通管理员不应能审核认证申请",
  );

  const adminToken = await loginAdmin();
  const pending = await api("GET", `/api/admin/acceptor-profiles?status=1`, { token: adminToken });
  assert.equal(pending.status, 200);
  assert.ok(
    pending.body.data.list.every((item) => item.id_card_no === undefined),
    "认证列表不应包含完整身份证号",
  );

  const idCard = await api("GET", `/api/admin/acceptor-profiles/${profileId}/id-card`, {
    token: adminToken,
  });
  assert.equal(idCard.status, 200);
  assert.match(idCard.body.data.id_card_no, /^\d{17}[\dX]$/, "超级管理员可查看完整号码");

  const audit = queryOne(
    "SELECT * FROM operation_logs WHERE action = 'view_id_card' AND target_id = ? ORDER BY id DESC",
    [profileId],
  );
  assert.ok(audit, "查看完整身份证号必须写入审计日志");
});

test("驳回认证后可以重新提交，且旧审核结论会被清空", async () => {
  const adminToken = await loginAdmin();
  const applicant = await createFundedUser(200);

  const applied = await api("POST", "/api/acceptor/apply", {
    token: applicant.token,
    body: {
      realName: "赵六",
      idCardNo: makeIdCardNo(),
      phone: "13800138003",
      idCardFront: "/uploads/f.png",
      idCardBack: "/uploads/b.png",
    },
  });
  assert.equal(applied.status, 200);
  const profileId = applied.body.data.profile.id;

  const rejected = await api("PUT", `/api/admin/acceptor-profiles/${profileId}/review`, {
    token: adminToken,
    body: { approved: false, reviewNote: "证件照片不清晰" },
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

  const info = await api("GET", "/api/acceptor/profile", { token: applicant.token });
  assert.equal(Number(info.body.data.status), 4, "驳回后状态应为未通过");
  assert.equal(info.body.data.profile.review_note, "证件照片不清晰");
  assert.equal(info.body.data.can_accept, false);
  assert.ok(info.body.data.blocked_reason, "应给出不可接单的原因");

  // 未通过状态下不允许缴保证金
  assert.equal(
    (await api("POST", "/api/acceptor/deposit", { token: applicant.token })).status,
    409,
    "未通过审核时不应允许缴纳保证金",
  );

  // 重新提交后回到待审核，旧结论清空
  const reapplied = await api("POST", "/api/acceptor/apply", {
    token: applicant.token,
    body: {
      realName: "赵六",
      idCardNo: makeIdCardNo(),
      phone: "13800138003",
      idCardFront: "/uploads/f2.png",
      idCardBack: "/uploads/b2.png",
    },
  });
  assert.equal(reapplied.status, 200, JSON.stringify(reapplied.body));
  assert.equal(Number(reapplied.body.data.status), 1, "重新提交后应回到待审核");
  assert.equal(reapplied.body.data.profile.review_note, "", "重新提交应清空上一次审核意见");

  // 待审核期间重复提交会被拒绝
  assert.equal(
    (
      await api("POST", "/api/acceptor/apply", {
        token: applicant.token,
        body: {
          realName: "赵六",
          idCardNo: makeIdCardNo(),
          phone: "13800138003",
          idCardFront: "/uploads/f3.png",
          idCardBack: "/uploads/b3.png",
        },
      })
    ).status,
    409,
    "审核中不应允许重复提交",
  );
});

test("后台仪表盘会统计接单员数量与待审核申请", async () => {
  const adminToken = await loginAdmin();
  const dashboard = await api("GET", "/api/admin/dashboard", { token: adminToken });
  assert.equal(dashboard.status, 200);
  const metrics = dashboard.body.data.metrics;
  assert.ok(Number(metrics.acceptorCount) >= 1, "应统计已认证接单员数量");
  assert.ok(
    Number(metrics.pendingAcceptorReviews) >= 1,
    "应统计待审核的认证申请数量",
  );
});
