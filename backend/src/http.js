// HTTP 基础层：错误类型、统一响应、参数校验、限流、CORS。
// 从 server.js 抽出（原 server.js 单文件 1451 行，路由、校验、业务、事务全部混杂）。

const { clientAddress } = require("./network");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const rateLimitStore = new Map();

// 限流只对"显式关闭"生效的逃生口：自动化测试会在几秒内创建几十个用户、
// 反复调用同一批接口（登录 / 充值 / 认证申请），必然超出按分钟计的阈值。
// 该开关默认关闭——不设置 RATE_LIMIT_DISABLED 时行为与之前完全一致，
// 生产部署不会因为忘记配置而失去防护。
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === "1";

// 周期性清理过期的限流计数，避免长时间运行后 Map 无限增长
setInterval(() => {
  const nowTs = Date.now();
  for (const [key, item] of rateLimitStore) {
    if (item.resetAt < nowTs) rateLimitStore.delete(key);
  }
}, 60_000).unref();

// 限流：单进程内存实现，按客户端标识 + 业务桶计数
function enforceRateLimit(req, bucket, limit = 120, windowMs = 60_000) {
  if (RATE_LIMIT_DISABLED) return;
  const key = `${clientAddress(req)}:${bucket}`;
  const current = rateLimitStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (current.resetAt < Date.now()) {
    current.count = 0;
    current.resetAt = Date.now() + windowMs;
  }
  current.count += 1;
  rateLimitStore.set(key, current);
  if (current.count > limit) throw new HttpError(429, "操作过于频繁，请稍后再试");
}

// CORS 解析。修复前统一返回 Access-Control-Allow-Origin: *，等于允许任意站点
// 携带用户的 Bearer 令牌调用全部已认证接口。现在的默认策略：
//   - 同源请求：放行
//   - 本机开发地址（localhost / 127.0.0.1 任意端口）：放行，保证本地调试不受影响
//   - 其他来源：仅当 CORS_ORIGINS 显式列出时才放行
//   - 小程序端使用原生网络栈，不带 Origin 头，不受影响
function resolveCorsOrigin(req) {
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return null;
  const allowList = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowList.includes("*") || allowList.includes(origin)) return origin;
  try {
    const target = new URL(origin);
    if (target.host === req.headers.host) return origin;
    const isLocalDev =
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(target.hostname) &&
      ["http:", "https:"].includes(target.protocol);
    if (isLocalDev) return origin;
  } catch {
    return null;
  }
  return null;
}

function sendJson(res, status, payload) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (res.corsOrigin) {
    headers["Access-Control-Allow-Origin"] = res.corsOrigin;
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
  }
  res.writeHead(status, headers);
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
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
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

// 分页参数解析。
// 修复背景：原先写作 Math.max(1, Number(url.searchParams.get("page") || 1))，
// 当传入 ?page=abc 时 Number("abc") 为 NaN，Math.max(1, NaN) 仍是 NaN，
// 该值直接进入 SQL 的 OFFSET，导致查询抛错并返回 HTTP 500。
function readPagination(url, defaultSize = 20, maxSize = 50) {
  const rawPage = Number(url.searchParams.get("page") ?? 1);
  const rawSize = Number(url.searchParams.get("pageSize") ?? defaultSize);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(maxSize, Math.floor(rawSize)) : defaultSize;
  return { page, pageSize };
}

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

// 金额解析：强制最多两位小数。
// 修复背景：原先只做 Number() + 区间判断，1.005 这类金额会被接受，
// 与库里 REAL 浮点存储叠加后会放大精度误差。
function readMoney(value, { min, max, label }) {
  const raw = String(value ?? "").trim();
  requireValue(raw !== "", `${label}不能为空`);
  requireValue(MONEY_PATTERN.test(raw), `${label}最多保留两位小数`);
  const amount = Number(raw);
  requireValue(
    Number.isFinite(amount) && amount >= min && amount <= max,
    `${label}需在 ${min}-${max} 元之间`,
  );
  return amount;
}

module.exports = {
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
};
