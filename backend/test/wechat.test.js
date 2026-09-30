const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

process.env.WECHAT_MOCK_LOGIN = "1";

const {
  WeChatAuthError,
  exchangeCodeForSession,
  validateWeChatConfiguration,
} = require("../src/wechat");

test("mock login keeps the demo account stable", async () => {
  validateWeChatConfiguration();
  const session = await exchangeCodeForSession("demo-user");
  assert.equal(session.openid, "demo-user");
  assert.equal(session.mock, true);
});

test("mock login maps a WeChat code to a deterministic development openid", async () => {
  const code = "wx-test-code";
  const digest = crypto.createHash("sha256").update(code).digest("hex").slice(0, 32);
  const session = await exchangeCodeForSession(code);
  assert.equal(session.openid, `mock-${digest}`);
});

test("mock login reuses one account for a stable development device", async () => {
  const first = await exchangeCodeForSession("first-code", "device-001");
  const second = await exchangeCodeForSession("second-code", "device-001");
  assert.equal(first.openid, second.openid);
});

test("login rejects an empty code", async () => {
  await assert.rejects(
    exchangeCodeForSession(""),
    (error) => error instanceof WeChatAuthError && error.status === 400,
  );
});
