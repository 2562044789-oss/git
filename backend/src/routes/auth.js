// 认证域：用户微信登录 / 管理员登录。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
// 注意：登录接口在统一鉴权之前分发（调用方还没有 identity）。
const { signToken, verifyPassword } = require("../auth");
const { get, now, run } = require("../db");
const {
  HttpError,
  enforceRateLimit,
  ok,
  optionalText,
  parseBody,
} = require("../http");
const { isTrustedDemoRequest } = require("../network");
const { publicUser } = require("../views");
const { exchangeCodeForSession } = require("../wechat");

module.exports = async function handleAuth(req, res, url, ctx) {
  const { method, pathname, createMessage } = ctx;

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
    ok(res, {
      token,
      user: publicUser(user),
      is_new_user: isNewUser,
      login_mode: session.mock ? "mock" : "wechat",
    });
    return true;
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
    ok(res, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        real_name: admin.real_name,
        role: admin.role,
      },
    });
    return true;
  }

  return false;
};
