// 修复前后对比验证脚本（人工复核用）
//
// 用法：
//   1. 另开一个终端启动后端（建议用临时库，避免影响演示数据）：
//        cd backend
//        DATABASE_PATH=/tmp/sunshine-verify.sqlite PORT=3999 node --no-warnings src/server.js
//   2. 运行本脚本：
//        node scripts/verify-fixes.js
//      （或用 BASE=http://127.0.0.1:3999 指定地址）
//
// 脚本会逐条重放当初审计中"已实证"的 6 个问题，并给出修复后的实际结果。
// 注意：模拟登录 / 模拟充值在修复后仍然对"本机与局域网"开放，
// 这是刻意保留的——否则浏览器预览页和手机真机演示都会失效。
// 被堵住的是公网来源（带反向代理转发头，或非私有网段地址）。

const crypto = require("node:crypto");

const BASE = process.env.BASE || "http://127.0.0.1:3999";
const OLD_LEAKED_SECRET = "sunshine-community-dev-secret"; // 修复前源码里公开的默认密钥

const results = [];

function record(id, title, expectation, actual, ok) {
  results.push({ id, title, expectation, actual, ok });
  console.log(
    `${ok ? "✅ 已修复" : "❌ 仍存在"}  [${id}] ${title}\n` +
      `      期望：${expectation}\n` +
      `      实际：${actual}`,
  );
}

async function call(method, path, { token, body, headers } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
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
  return { status: response.status, json: payload, response };
}

function forgeToken(payload) {
  const encode = (value) => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encode(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  const signature = crypto
    .createHmac("sha256", OLD_LEAKED_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

async function mockLogin(code) {
  const result = await call("POST", "/api/auth/login", { body: { code } });
  return result.json?.data;
}

let seq = 0;
async function newUser(credit = 200) {
  seq += 1;
  const session = await mockLogin(`verify-${Date.now()}-${seq}`);
  if (credit > 0) {
    await call("POST", "/api/wallet/recharge", { token: session.token, body: { amount: credit } });
  }
  return session;
}

async function balance(token) {
  return (await call("GET", "/api/wallet", { token })).json?.data?.balance;
}

(async () => {
  console.log("=".repeat(72));
  console.log("阳光社区邻里快办 —— 缺陷修复前后对比验证");
  console.log(`目标服务：${BASE}`);
  console.log("=".repeat(72));

  // ---------------------------------------------------------------- 1 / 2
  const forgedAdmin = forgeToken({ id: 1, type: "admin" });
  const r1 = await call("GET", "/api/admin/users", { token: forgedAdmin });
  record(
    "1",
    "用源码中公开的默认密钥伪造管理员令牌",
    "HTTP 401（令牌签名不通过）",
    `HTTP ${r1.status}`,
    r1.status === 401,
  );

  const forgedUser = forgeToken({ id: 1, type: "user" });
  const r2 = await call("GET", "/api/user/profile", { token: forgedUser });
  record(
    "2",
    "伪造任意用户身份读取资料与余额",
    "HTTP 401",
    `HTTP ${r2.status}`,
    r2.status === 401,
  );

  // ---------------------------------------------------------------- 3 / 4
  const r3a = await call("POST", "/api/auth/login", {
    body: { code: "demo-user" },
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  const r3b = await call("POST", "/api/auth/login", { body: { code: "demo-user" } });
  record(
    "3",
    "模拟登录（绕过微信授权接管演示账号）",
    "公网来源 403 / 本机来源 200（演示可用）",
    `公网来源 HTTP ${r3a.status}，本机来源 HTTP ${r3b.status}`,
    r3a.status === 403 && r3b.status === 200,
  );

  const demoTicket = await mockLogin("demo-user");
  const balanceBefore = await balance(demoTicket.token);
  const r4a = await call("POST", "/api/wallet/recharge", {
    token: demoTicket.token,
    body: { amount: 1000 },
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  const balanceAfterBlocked = await balance(demoTicket.token);
  const r4b = await call("POST", "/api/wallet/recharge", {
    token: demoTicket.token,
    body: { amount: 10 },
  });
  record(
    "4",
    "模拟充值（无需支付即可给自己加钱）",
    "公网来源 403 且余额不变 / 本机来源 200（演示可用）",
    `公网来源 HTTP ${r4a.status}，余额 ${balanceBefore} → ${balanceAfterBlocked}；` +
      `本机来源 HTTP ${r4b.status}`,
    r4a.status === 403 &&
      Number(balanceAfterBlocked) === Number(balanceBefore) &&
      r4b.status === 200,
  );

  // ---------------------------------------------------------------- 5
  const r5 = await call("GET", "/api/tasks?page=abc");
  record(
    "5",
    "非法分页参数 page=abc 触发 500",
    "HTTP 200，page 归一化为 1",
    `HTTP ${r5.status}，page=${r5.json?.data?.page}`,
    r5.status === 200 && r5.json?.data?.page === 1,
  );

  // ---------------------------------------------------------------- 6
  const adminLogin = await call("POST", "/api/admin/login", {
    body: { username: "admin", password: "admin123" },
  });
  const adminToken = adminLogin.json?.data?.token;

  const publisher = await newUser(200);
  const acceptor = await newUser(0);

  const published = await call("POST", "/api/tasks", {
    token: publisher.token,
    body: {
      categoryId: 1,
      title: "修复验证用任务：代取快递",
      reward: 12,
      deliveryAddress: "阳光社区9栋",
    },
  });
  const taskId = published.json?.data?.id;
  const accepted = await call("POST", `/api/tasks/${taskId}/accept`, { token: acceptor.token });
  const orderId = accepted.json?.data?.id;
  await call("POST", `/api/orders/${orderId}/start`, { token: acceptor.token });
  await call("POST", `/api/orders/${orderId}/finish`, {
    token: acceptor.token,
    body: { images: ["/uploads/verify.png"] },
  });
  await call("POST", `/api/orders/${orderId}/confirm`, { token: publisher.token });

  const publisherSettled = await balance(publisher.token);
  const acceptorSettled = await balance(acceptor.token);

  const complaint = await call("POST", "/api/complaints", {
    token: acceptor.token,
    body: { orderId, reason: "服务与描述不符", description: "修复验证" },
  });
  const duplicate = await call("POST", "/api/complaints", {
    token: acceptor.token,
    body: { orderId, reason: "重复投诉" },
  });
  record(
    "7",
    "同一已完成订单可被反复投诉",
    "第二次投诉 409（提示已有待处理投诉）",
    `第一次 HTTP ${complaint.status}，第二次 HTTP ${duplicate.status}`,
    complaint.status === 200 && duplicate.status === 409,
  );

  await call("PUT", `/api/admin/complaints/${complaint.json?.data?.id}`, {
    token: adminToken,
    body: { verdict: "refund", handleResult: "修复验证：退款给发布者" },
  });
  const publisherFinal = await balance(publisher.token);
  const acceptorFinal = await balance(acceptor.token);

  const orderDetail = (await call("GET", `/api/orders/${orderId}`, { token: publisher.token })).json
    ?.data;
  const walletRecords = (await call("GET", "/api/wallet", { token: acceptor.token })).json?.data
    ?.records;

  record(
    "6",
    "已完成订单裁决退款时不产生任何资金流动（账实不符）",
    "接单者被扣回 12 元、发布者收到 12 元退款，且有对应流水",
    `接单者 ${acceptorSettled} → ${acceptorFinal}；发布者 ${publisherSettled} → ${publisherFinal}；` +
      `订单状态=${orderDetail?.status}/支付状态=${orderDetail?.pay_status}；` +
      `扣回流水=${walletRecords?.some((row) => Number(row.type) === 2 && Number(row.amount) === -12)}`,
    Number(acceptorFinal) === Number(acceptorSettled) - 12 &&
      Number(publisherFinal) === Number(publisherSettled) + 12 &&
      Number(orderDetail?.pay_status) === 3 &&
      walletRecords?.some((row) => Number(row.type) === 2 && Number(row.amount) === -12),
  );

  // ---------------------------------------------------------------- 8
  const publisher2 = await newUser(200);
  const acceptor2 = await newUser(0);
  const published2 = await call("POST", "/api/tasks", {
    token: publisher2.token,
    body: { categoryId: 1, title: "修复验证用任务：驳回恢复", reward: 10 },
  });
  const taskId2 = published2.json?.data?.id;
  const accepted2 = await call("POST", `/api/tasks/${taskId2}/accept`, { token: acceptor2.token });
  const orderId2 = accepted2.json?.data?.id;
  await call("POST", `/api/orders/${orderId2}/start`, { token: acceptor2.token });
  await call("POST", `/api/orders/${orderId2}/finish`, {
    token: acceptor2.token,
    body: { images: ["/uploads/verify.png"] },
  });
  await call("POST", `/api/orders/${orderId2}/confirm`, { token: publisher2.token });
  const complaint2 = await call("POST", "/api/complaints", {
    token: publisher2.token,
    body: { orderId: orderId2, reason: "服务与描述不符" },
  });
  const taskInDispute = (
    await call("GET", `/api/orders/${orderId2}`, { token: publisher2.token })
  ).json?.data?.task_status;
  await call("PUT", `/api/admin/complaints/${complaint2.json?.data?.id}`, {
    token: adminToken,
    body: { verdict: "reject", handleResult: "修复验证：驳回" },
  });
  const taskAfterReject = (
    await call("GET", `/api/orders/${orderId2}`, { token: publisher2.token })
  ).json?.data?.task_status;

  record(
    "8",
    "裁决驳回后任务永久卡在争议中（status 6）",
    "投诉后为 6，驳回后恢复为 4（已完成）",
    `投诉后任务状态=${taskInDispute}，驳回后任务状态=${taskAfterReject}`,
    Number(taskInDispute) === 6 && Number(taskAfterReject) === 4,
  );

  // ---------------------------------------------------------------- 汇总
  const passed = results.filter((item) => item.ok).length;
  console.log("\n" + "=".repeat(72));
  console.log(`汇总：${passed} / ${results.length} 项已确认修复`);
  for (const item of results) {
    console.log(`  ${item.ok ? "✅" : "❌"} [${item.id}] ${item.title}`);
  }
  console.log("=".repeat(72));
  if (passed !== results.length) process.exitCode = 1;
})().catch((error) => {
  console.error("脚本异常：", error);
  process.exitCode = 1;
});
