const crypto = require("node:crypto");

const SECRET = process.env.JWT_SECRET || "sunshine-community-dev-secret";
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// 生产环境必须显式配置随机 JWT 密钥，避免使用公开的开发默认值
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("生产环境必须通过环境变量 JWT_SECRET 配置随机长密钥");
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signToken(payload) {
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encode(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  if (
    expected.length !== parts[2].length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(decode(parts[1]));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = {
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
};
