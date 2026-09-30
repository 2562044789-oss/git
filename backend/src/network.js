// 请求来源判定与限流标识。
//
// 修复背景（原审计问题 #2 / #3 / #7）：
// 1. 模拟登录（code: "demo-user"）与模拟充值原本默认全开，部署到公网后任何人都能
//    无凭证登录、无限充值。现在这类"演示后门"只允许来自本机 / 局域网；
// 2. 限流原本直接用 req.socket.remoteAddress 做键，前面挂反向代理后所有请求
//    都来自同一个 IP，限流要么完全失效、要么误伤全部用户。

function normalizeAddress(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
}

// 本机回环地址与 RFC1918 私有网段（含 IPv6 ULA / 链路本地）
function isLoopbackOrPrivate(address) {
  const ip = normalizeAddress(address);
  if (!ip) return false;
  if (ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const v4 = ip.match(/^172\.(\d{1,3})\./);
  if (v4) {
    const second = Number(v4[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

// 只要出现任何代理转发头，就一律视为"非本机请求"。
// 原因：反向代理通常与后端部署在同一台机器上，此时 remoteAddress 会是 127.0.0.1，
// 若仅凭 remoteAddress 判断，公网请求会被误判成本机调试请求，后门重新敞开。
function hasProxyHeader(req) {
  return Boolean(
    req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.headers["forwarded"] ||
      req.headers["x-forwarded-host"] ||
      req.headers["cf-connecting-ip"],
  );
}

// 是否允许使用演示后门（模拟登录 / 模拟充值）。
// 本机与局域网可用，保证浏览器预览页与手机真机演示不受影响；
// 公网地址一律拒绝。如需在公网演示，显式设置 ALLOW_INSECURE_DEMO=1（风险自负）。
function isTrustedDemoRequest(req) {
  if (process.env.ALLOW_INSECURE_DEMO === "1") return true;
  if (!req) return false;
  if (hasProxyHeader(req)) return false;
  return isLoopbackOrPrivate(req.socket?.remoteAddress);
}

// 限流使用的客户端标识。默认不信任转发头；显式设置 TRUST_PROXY=1 时才采用
// X-Forwarded-For 的首段，避免"配置了反代就退化成全体共用一个计数桶"。
function clientAddress(req) {
  if (!req) return "unknown";
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0];
    if (forwarded && forwarded.trim()) return forwarded.trim();
  }
  return String(req.socket?.remoteAddress || "unknown");
}

module.exports = {
  clientAddress,
  hasProxyHeader,
  isLoopbackOrPrivate,
  isTrustedDemoRequest,
  normalizeAddress,
};
