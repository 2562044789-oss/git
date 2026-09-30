const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// JWT 密钥来源（按优先级）：
//   1. 环境变量 JWT_SECRET
//   2. 本地持久化密钥文件（首次运行自动生成）
//
// 修复背景（原审计问题 #1）：原先写作
//   const SECRET = process.env.JWT_SECRET || "sunshine-community-dev-secret";
//   if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) throw ...
// 也就是——先声明是生产环境才做检查。不声明就静默使用源码里公开的默认密钥，
// 任何人都能用它自签一个 {id:1,type:"admin"} 令牌直接拿到管理员权限。
// 现在彻底移除硬编码默认值：没有配置就随机生成并落盘，攻击者无从得知密钥；
// 同时保持"零配置启动"，本地演示与答辩演示不受影响。
function resolveSecretFile() {
  const explicit = String(process.env.JWT_SECRET_FILE || "").trim();
  if (explicit) return explicit;
  const databasePath = String(process.env.DATABASE_PATH || "").trim();
  if (databasePath) return path.join(path.dirname(path.resolve(databasePath)), "jwt-secret.key");
  return path.join(__dirname, "..", "data", "jwt-secret.key");
}

function loadSecret() {
  const fromEnv = String(process.env.JWT_SECRET || "").trim();
  if (fromEnv) {
    if (fromEnv.length < 16) {
      throw new Error("JWT_SECRET 长度不足，请配置至少 16 位的随机密钥");
    }
    if (fromEnv === "sunshine-community-dev-secret") {
      throw new Error("检测到源码中公开的示例密钥，请更换为随机密钥后再启动");
    }
    return { value: fromEnv, source: "环境变量 JWT_SECRET" };
  }

  const secretFile = resolveSecretFile();
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 32) {
      return { value: existing, source: `本地密钥文件 ${secretFile}` };
    }
  } catch {
    // 文件不存在或不可读 → 走首次生成流程
  }

  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return { value: generated, source: `首次运行自动生成 ${secretFile}` };
}

const { value: SECRET, source: SECRET_SOURCE } = loadSecret();

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
  SECRET_SOURCE,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
};
