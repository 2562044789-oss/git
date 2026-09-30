const crypto = require("node:crypto");

const APP_ID = process.env.WECHAT_APP_ID || process.env.WECHAT_APPID || "";
const APP_SECRET = process.env.WECHAT_APP_SECRET || process.env.WECHAT_SECRET || "";
const REQUEST_TIMEOUT_MS = Number(process.env.WECHAT_REQUEST_TIMEOUT_MS || 8000);
const CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";

class WeChatAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isWeChatConfigured() {
  return Boolean(APP_ID && APP_SECRET);
}

function validateWeChatConfiguration() {
  if (Boolean(APP_ID) !== Boolean(APP_SECRET)) {
    throw new Error("微信登录配置不完整，请同时设置 WECHAT_APP_ID 和 WECHAT_APP_SECRET");
  }
  if (!isWeChatConfigured() && !isMockLoginEnabled()) {
    throw new Error("微信登录未配置，请设置 WECHAT_APP_ID 和 WECHAT_APP_SECRET");
  }
}

function isMockLoginEnabled() {
  if (process.env.WECHAT_MOCK_LOGIN === "1") return true;
  if (process.env.WECHAT_MOCK_LOGIN === "0") return false;
  return process.env.NODE_ENV !== "production" && !isWeChatConfigured();
}

function mockSession(code, deviceId) {
  if (code === "demo-user") {
    return { openid: "demo-user", unionid: null, sessionKey: "", mock: true };
  }
  const source = String(deviceId || "").trim() || code;
  const digest = crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
  return { openid: `mock-${digest}`, unionid: null, sessionKey: "", mock: true };
}

function wechatError(payload) {
  const code = Number(payload.errcode);
  const message = String(payload.errmsg || "").toLowerCase();
  if ([40029, 40163].includes(code)) {
    return new WeChatAuthError(401, "微信登录凭证无效，请重新登录");
  }
  if (code === 45011 || message.includes("frequently")) {
    return new WeChatAuthError(429, "微信登录请求过于频繁，请稍后再试");
  }
  if ([40013, 40125].includes(code)) {
    return new WeChatAuthError(500, "微信小程序登录配置错误");
  }
  return new WeChatAuthError(502, "微信登录服务暂时不可用，请稍后再试");
}

// options.allowMock：本次请求是否允许走本地模拟登录。
//
// 修复背景（原审计问题 #2）：模拟登录默认全开，且不区分请求来源，
// 部署到公网后 POST /api/auth/login {"code":"demo-user"} 即可免授权登录任意演示账号。
// 现在由调用方（server.js）按请求来源决定——本机/局域网允许，公网拒绝。
async function exchangeCodeForSession(code, deviceId = "", options = {}) {
  const { allowMock = true } = options;
  const jsCode = String(code || "").trim();
  if (!jsCode) throw new WeChatAuthError(400, "缺少微信登录 code");
  if (jsCode.length > 128) throw new WeChatAuthError(400, "微信登录 code 无效");

  validateWeChatConfiguration();
  if (isMockLoginEnabled()) {
    if (!allowMock) {
      throw new WeChatAuthError(
        403,
        "模拟登录仅限本机或局域网调试使用；公网环境请配置 WECHAT_APP_ID / WECHAT_APP_SECRET",
      );
    }
    return mockSession(jsCode, deviceId);
  }
  if (!isWeChatConfigured()) {
    throw new WeChatAuthError(500, "微信登录尚未配置");
  }

  const url = new URL(CODE2SESSION_URL);
  url.search = new URLSearchParams({
    appid: APP_ID,
    secret: APP_SECRET,
    js_code: jsCode,
    grant_type: "authorization_code",
  }).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new WeChatAuthError(504, "微信登录服务响应超时，请重试");
    }
    throw new WeChatAuthError(502, "无法连接微信登录服务，请稍后重试");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new WeChatAuthError(502, "微信登录服务暂时不可用，请稍后再试");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new WeChatAuthError(502, "微信登录服务返回了无效数据");
  }

  if (payload.errcode) throw wechatError(payload);
  if (!payload.openid) throw new WeChatAuthError(502, "微信登录服务未返回 openid");

  return {
    openid: String(payload.openid),
    unionid: payload.unionid ? String(payload.unionid) : null,
    sessionKey: payload.session_key ? String(payload.session_key) : "",
    mock: false,
  };
}

module.exports = {
  WeChatAuthError,
  exchangeCodeForSession,
  isMockLoginEnabled,
  isWeChatConfigured,
  validateWeChatConfiguration,
};
