// 校验首页「接单员招募」广告的按钮文案与保证金金额。
//
// 这段逻辑写在前端里、没法 require，所以把相关代码原样切出来求值，
// 确保测的是真实上线的那段代码，而不是抄一份副本。
//
// 广告位曾是一条独立的滚动条，按需求已删掉，现在只剩轮播的第 2 张。
// 因此在文案映射之外，本脚本还守两类容易悄悄坏掉的东西：
//   1. 删滚动条时别把认证入口一起删掉（轮播第 2 张是首页唯一入口）；
//   2. 滚动条不该再出现在任何一端（删干净，别留半截样式或死代码）。
const fs = require("node:fs");
const path = require("node:path");

const previewDir = path.join(__dirname, "..", "public", "preview");
const homeDir = path.join(__dirname, "..", "..", "miniprogram", "pages", "home");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`切片失败: ${startMarker}`);
  return source.slice(start, end);
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

// ---- 浏览器预览端 ----
const previewSource = read(path.join(previewDir, "app.js"));
const previewSnippet = extract(
  previewSource,
  "const ACCEPTOR_AD_CTA",
  "function statusMeta(",
);
// acceptorCta 内部调用模块作用域的 acceptorOf()，这里用参数把它顶替掉
const previewFactory = new Function(
  "acceptorOf",
  `${previewSnippet}\nreturn acceptorCta;`,
);
const previewCta = (acceptor) => previewFactory(() => acceptor)();

// ---- 小程序端 ----
const miniSource = read(path.join(homeDir, "home.js"));
const miniSnippet = extract(miniSource, "const ACCEPTOR_AD_CTA", "Page({");
const miniFactory = new Function(`${miniSnippet}\nreturn buildAcceptorAd;`);
const miniAd = (acceptor) => miniFactory()(acceptor);

// 六种认证状态各自的按钮文案。已认证(3) 的人给"查看权益"而不是"立即申请"，
// 否则"能接单的人还一直看到申请入口"会很奇怪。
const CASES = [
  { status: 0, cta: "立即申请" },
  { status: 1, cta: "查看进度" },
  { status: 2, cta: "去缴纳" },
  { status: 3, cta: "查看权益" },
  { status: 4, cta: "重新提交" },
  { status: 5, cta: "重新认证" },
];

console.log("== 浏览器预览端：按钮文案按认证进度分档 ==");
for (const item of CASES) {
  const cta = previewCta({ status: item.status, required_deposit: 50 });
  check(`status=${item.status} 按钮为「${item.cta}」`, cta === item.cta, `→ ${cta}`);
}
// 取不到认证信息时按未认证兜底，与后端 fail-closed 的口径一致
const previewFallback = previewCta(null);
check(
  "无认证信息时按未认证兜底",
  previewFallback === "立即申请",
  `→ ${previewFallback}`,
);

console.log("== 小程序端：按钮文案 + 保证金金额 ==");
for (const item of CASES) {
  const ad = miniAd({ status: item.status, required_deposit: 50 });
  check(`status=${item.status} 按钮为「${item.cta}」`, ad.cta === item.cta, `→ ${ad.cta}`);
}
const miniFallback = miniAd(null);
check(
  "无认证信息时按未认证兜底",
  miniFallback.cta === "立即申请" && miniFallback.deposit === "50",
  `→ ${miniFallback.cta} / ¥${miniFallback.deposit}`,
);
// 轮播第 2 张的正文里要写金额，金额必须来自后端配置而不是写死
check(
  "保证金金额跟随后端配置变化",
  miniAd({ status: 0, required_deposit: 100 }).deposit === "100",
  `→ ¥${miniAd({ status: 0, required_deposit: 100 }).deposit}`,
);
check(
  "整数金额不带多余的 .00",
  miniAd({ status: 0, required_deposit: 50 }).deposit === "50",
  `→ ¥${miniAd({ status: 0, required_deposit: 50 }).deposit}`,
);

console.log("== 首页认证入口仍在（删滚动条时最容易被误伤） ==");
const miniWxml = read(path.join(homeDir, "home.wxml"));
check(
  "预览端轮播第 2 张仍带 action=acceptor",
  /action:\s*"acceptor"/.test(previewSource),
);
check(
  "预览端 data-action 分发仍处理 acceptor",
  /dataset\.action[\s\S]{0,600}?"acceptor"/.test(previewSource),
);
check(
  "小程序轮播第 2 张仍引用 {{acceptorAd.cta}}",
  /\{\{acceptorAd\.cta\}\}/.test(miniWxml),
);
check(
  "小程序轮播第 2 张仍绑定 goAcceptor",
  /bindtap="goAcceptor"/.test(miniWxml),
);
check(
  "小程序 goAcceptor 仍指向认证页",
  /goAcceptor\(\)\s*\{[\s\S]*?\/pages\/acceptor\/acceptor/.test(miniSource),
);

console.log("== 回归：滚动条已删除，两端都不该再出现 ==");
const MARQUEE_MARKERS = [
  ["预览端 app.js", path.join(previewDir, "app.js")],
  ["预览端 styles.css", path.join(previewDir, "styles.css")],
  ["小程序 home.wxml", path.join(homeDir, "home.wxml")],
  ["小程序 home.wxss", path.join(homeDir, "home.wxss")],
  ["小程序 home.js", path.join(homeDir, "home.js")],
];
for (const [label, file] of MARQUEE_MARKERS) {
  const source = read(file);
  check(
    `${label} 无 acceptor-ad 残留`,
    !source.includes("acceptor-ad"),
    "文案/样式应已随滚动条一并移除",
  );
}
for (const [label, file] of [
  ["预览端 app.js", path.join(previewDir, "app.js")],
  ["小程序 home.js", path.join(homeDir, "home.js")],
]) {
  check(
    `${label} 无 ACCEPTOR_AD_TEXT 死代码`,
    !read(file).includes("ACCEPTOR_AD_TEXT"),
    "长文案随滚动条一起删掉，只保留按钮文案映射",
  );
}

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
