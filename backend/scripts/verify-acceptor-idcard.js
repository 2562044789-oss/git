// 用可执行的方式说明「接单员认证到底验了什么、没验什么」。
//
// 结论先说：**只做离线格式校验，不联网核验真伪**。
// 因此一个虚构的身份证号，只要格式与校验位算对，就能通过接口进入"待审核"。
// 真伪由管理员人工比对证件照片 —— 这是本项目的既定边界，不是漏掉的 TODO。
//
// 这个脚本把这条边界钉成断言：如果以后有人真的接了实名核验（公安/运营商三要素），
// 「虚构号码应当通过」这条会失败，那时应当更新脚本，而不是当成 bug 去改业务代码。
//
// 跑法：node --no-warnings scripts/verify-acceptor-idcard.js
// 用临时库 + 独立端口，不碰演示数据。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3014;
const BASE = `http://127.0.0.1:${PORT}`;
const BACKEND = path.join(__dirname, "..");
const DB = path.join(os.tmpdir(), `acceptor-idcard-${Date.now()}.sqlite`);

// 与后端同一套校验位算法（GB 11643-1999）：前 17 位随便编，第 18 位必然能算出"合法"值。
// 能这么算，本身就说明校验位只保证"号码没抄错"，不保证"这个人存在"。
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CHARS = "10X98765432";
function fabricate(prefix17) {
  const sum = [...prefix17].reduce((total, ch, i) => total + Number(ch) * WEIGHTS[i], 0);
  return prefix17 + CHECK_CHARS[sum % 11];
}

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = { msg: "(非 JSON 响应)" };
  }
  return { status: res.status, body: payload };
}

const PHOTOS = { idCardFront: "/uploads/demo-front.png", idCardBack: "/uploads/demo-back.png" };
const apply = (token, overrides) =>
  api(
    "POST",
    "/api/acceptor/apply",
    { ...PHOTOS, realName: "李假证", phone: "13800000000", ...overrides },
    token,
  );

(async () => {
  const server = spawn(process.execPath, ["--no-warnings", "src/server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_PATH: DB,
      WECHAT_MOCK_LOGIN: "1",
      RATE_LIMIT_DISABLED: "1",
    },
    stdio: "ignore",
  });

  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        await fetch(`${BASE}/api/config`);
        ready = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!ready) throw new Error("后端未能在 10 秒内就绪");

    // 全新模拟登录用户，不是演示库里的任何账号
    const login = await api("POST", "/api/auth/login", { code: "idcard-probe" });
    const token = login.body.data.token;

    console.log("== 虚构但格式合法的号码：能通过 ==");
    const fake = fabricate("11010119900315" + "777");
    const fakeRes = await apply(token, { realName: "李假证", idCardNo: fake });
    check(
      `虚构号码 ${fake} 提交成功（HTTP ${fakeRes.status}）`,
      fakeRes.status === 200,
      `→ ${fakeRes.body.msg}`,
    );
    check(
      "进入「待审核」而非直接通过（人工复核是唯一真伪关卡）",
      Number(fakeRes.body.data?.status) === 1,
      `→ status=${fakeRes.body.data?.status}`,
    );

    console.log("\n== 后端真正会拦住的：格式类错误 ==");
    const badCheck = fabricate("11010119900315" + "778");
    const wrongCheckDigit = badCheck.slice(0, 17) + (badCheck[17] === "0" ? "1" : "0");
    const cases = [
      ["校验位算错", { idCardNo: wrongCheckDigit, realName: "张三" }, 400],
      ["出生日期是 2 月 30 日", { idCardNo: fabricate("11010119900230" + "777"), realName: "张三" }, 400],
      ["出生年份写成 1800", { idCardNo: fabricate("11010118000315" + "777"), realName: "张三" }, 400],
      ["只有 17 位", { idCardNo: "11010119900315001", realName: "张三" }, 400],
      ["姓名写成英文单字", { idCardNo: fabricate("11010119900315" + "778"), realName: "A" }, 400],
      ["手机号写成 1380000000（10 位）", { idCardNo: fabricate("11010119900315" + "779"), realName: "张三", phone: "1380000000" }, 400],
      ["只上传一张证件照", { idCardNo: fabricate("11010119900315" + "780"), realName: "张三", idCardFront: "/x.png", idCardBack: "" }, 400],
    ];
    for (const [label, overrides, expected] of cases) {
      const res = await apply(token, overrides);
      check(`${label} → HTTP ${expected}`, res.status === expected, `→ ${res.status} ${res.body.msg}`);
    }

    console.log("\n== 同一号码只能绑一个账号 ==");
    const dup = await api("POST", "/api/auth/login", { code: "idcard-probe-2" });
    const dupRes = await apply(dup.body.data.token, { realName: "王五", idCardNo: fake });
    check("复用已绑定的号码 → HTTP 409", dupRes.status === 409, `→ ${dupRes.status} ${dupRes.body.msg}`);

    console.log("\n== 结论 ==");
    console.log(`  通过虚构号码提交后，该申请的 status = ${fakeRes.body.data?.status}（1 = 待审核）`);
    console.log("  接口只验证：18 位格式、出生日期真实、GB 11643-1999 校验位、号码未被占用、");
    console.log("             姓名是中文、手机号 11 位、两张证件照都有值。");
    console.log("  接口不验证：号码是否真属于这个人（无公安/运营商核验）、照片是否是真人证件。");
    console.log("  真伪由管理员在后台人工比对证件照片 —— 见 PUT /api/admin/acceptor-profiles/:id/review。");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(DB + suffix);
      } catch {}
    }
  }

  console.log(`\n结果: ${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
