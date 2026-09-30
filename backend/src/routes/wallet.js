// 钱包域：充值 / 提现 / 余额与流水查询。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
//
// 约定：匹配到本域路由就处理并 return true，否则 return false 交给下一个域。
// 依赖分两类：db/http/network 等基础模块直接 import；
// identity、环境开关（rechargeMode 等）、业务 helper（logOperation 等）由
// server.js 以 ctx 注入，避免 routes 反向 require server.js 造成循环依赖。
const crypto = require("node:crypto");
const { all, get, now, run, transaction } = require("../db");
const {
  HttpError,
  enforceRateLimit,
  ok,
  parseBody,
  readMoney,
  requireValue,
} = require("../http");
const { isTrustedDemoRequest } = require("../network");

module.exports = async function handleWallet(req, res, url, ctx) {
  const { method, pathname, identity, rechargeMode, withdrawMode, logOperation } = ctx;

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
    ok(res, { ...result, mode: "mock", paid: true }, "充值成功");
    return true;
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
    ok(res, { ...result, mode: "mock", paid: true }, "提现成功");
    return true;
  }

  if (method === "GET" && pathname === "/api/wallet") {
    const user = get("SELECT balance FROM users WHERE id = ?", [identity.id]);
    ok(res, {
      balance: user.balance,
      records: all(
        "SELECT * FROM wallet_records WHERE user_id = ? ORDER BY created_at DESC, id DESC",
        [identity.id],
      ),
    });
    return true;
  }

  return false;
};
