// 校验首页「接单员招募滚动条」的文案映射。
// 这段逻辑写在前端 app.js 里，没法直接 require，所以把这两块代码原样切出来求值，
// 确保测的是真实上线的那段代码，而不是抄一份副本。
const fs = require("node:fs");
const path = require("node:path");

const previewApp = path.join(__dirname, "..", "public", "preview", "app.js");
const miniApp = path.join(__dirname, "..", "..", "miniprogram", "pages", "home", "home.js");

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`切片失败: ${startMarker}`);
  return source.slice(start, end);
}

// ---- 浏览器预览端 ----
const previewSource = fs.readFileSync(previewApp, "utf8");
const previewSnippet = extract(
  previewSource,
  "// 首页「成为接单员」滚动广告的文案",
  "function statusMeta(",
);
// acceptorAdCopy 内部调用模块作用域的 acceptorOf()，这里用参数把它顶替掉
const previewFactory = new Function(
  "acceptorOf",
  `${previewSnippet}\nreturn acceptorAdCopy;`,
);
const previewCopy = (acceptor) => previewFactory(() => acceptor)();

// ---- 小程序端 ----
const miniSource = fs.readFileSync(miniApp, "utf8");
const miniSnippet = extract(
  miniSource,
  "// 首页「成为接单员」滚动广告的文案",
  "Page({",
);
const miniFactory = new Function(`${miniSnippet}\nreturn buildAcceptorAd;`);
const miniCopy = (acceptor) => miniFactory()(acceptor);

const CASES = [
  // hasAmount：该状态下文案是否应当出现保证金金额。
  // 未通过(4) 的人要先改资料，还没到谈钱的一步，故意不写金额。
  { status: 0, expect: "成为接单员", cta: "立即申请", hasAmount: true },
  { status: 1, expect: "审核中", cta: "查看进度", hasAmount: true },
  { status: 2, expect: "还差最后一步", cta: "去缴纳", hasAmount: true },
  { status: 3, expect: "你已是认证接单员", cta: "查看权益", hasAmount: true },
  { status: 4, expect: "未通过", cta: "重新提交", hasAmount: false },
  { status: 5, expect: "已退出", cta: "重新认证", hasAmount: true },
];

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

console.log("== 浏览器预览端 ==");
for (const item of CASES) {
  const copy = previewCopy({ status: item.status, required_deposit: 50 });
  check(
    `status=${item.status} 文案含「${item.expect}」且 CTA=${item.cta}`,
    copy.text.includes(item.expect) && copy.cta === item.cta,
    `→ ${copy.text} | ${copy.cta}`,
  );
  check(
    `status=${item.status} 占位符已替换${item.hasAmount ? "且金额可见" : "（该状态不展示金额）"}`,
    !copy.text.includes("{deposit}") && copy.text.includes("50") === item.hasAmount,
    `→ ${copy.text}`,
  );
}
// 取不到认证信息时按未认证兜底，不能报错
const fallback = previewCopy(null);
check(
  "无认证信息时按未认证兜底",
  fallback.cta === "立即申请" && fallback.text.includes("成为接单员"),
  `→ ${fallback.cta}`,
);
// 保证金金额跟随配置变化
const custom = previewCopy({ status: 0, required_deposit: 100 });
check("保证金金额跟随配置", custom.text.includes("100"), `→ ${custom.text}`);

console.log("== 小程序端 ==");
for (const item of CASES) {
  const copy = miniCopy({ status: item.status, required_deposit: 50 });
  check(
    `status=${item.status} 文案含「${item.expect}」且 CTA=${item.cta}`,
    copy.text.includes(item.expect) && copy.cta === item.cta,
    `→ ${copy.text} | ${copy.cta}`,
  );
  check(
    `status=${item.status} 占位符已替换${item.hasAmount ? "且金额可见" : "（该状态不展示金额）"}`,
    !copy.text.includes("{deposit}") && copy.text.includes("50") === item.hasAmount,
    `→ ${copy.text}`,
  );
}
const miniFallback = miniCopy(null);
check(
  "无认证信息时按未认证兜底",
  miniFallback.cta === "立即申请" && miniFallback.text.includes("成为接单员"),
  `→ ${miniFallback.cta}`,
);

console.log("\n== 结构不变量（滚动动画的前提） ==");

// translateX(-50%) 的无缝循环依赖"恰好两份相同文案"。
// 少一份会中途留白，多一份会错位 —— 这条不变量必须守住。
function checkMarqueeStructure(label, markup, tapAttr) {
  const copies = markup.match(/acceptor-ad-text/g) || [];
  check(`${label}：文案恰好两份（无缝循环的前提）`, copies.length === 2, `→ ${copies.length} 份`);
  check(`${label}：点击可跳转认证（${tapAttr}）`, markup.includes(tapAttr));
  check(
    `${label}：有左右渐隐遮罩容器`,
    markup.includes("acceptor-ad-window") &&
      markup.includes("acceptor-ad-fade left") &&
      markup.includes("acceptor-ad-fade right"),
  );
}

const previewMarkup = extract(
  previewSource,
  '<button class="acceptor-ad"',
  "</button>",
);
checkMarqueeStructure("预览端", previewMarkup, 'data-action="acceptor"');

const wxmlSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "miniprogram", "pages", "home", "home.wxml"),
  "utf8",
);
const wxmlMarkup = extract(wxmlSource, '<view class="acceptor-ad"', "</view>\n  </view>");
checkMarqueeStructure("小程序", wxmlMarkup, 'bindtap="goAcceptor"');
check(
  "小程序：首页已注册 goAcceptor 并指向认证页",
  /goAcceptor\(\)\s*\{[\s\S]*?\/pages\/acceptor\/acceptor/.test(miniSource),
);

// 两端样式都必须真的定义了滚动关键帧，否则文字不会动
for (const [label, file] of [
  ["预览端", path.join(__dirname, "..", "public", "preview", "styles.css")],
  ["小程序", path.join(__dirname, "..", "..", "miniprogram", "pages", "home", "home.wxss")],
]) {
  const css = fs.readFileSync(file, "utf8");
  check(
    `${label}：定义了 acceptor-ad-scroll 关键帧并位移 -50%`,
    /@keyframes acceptor-ad-scroll\s*\{[\s\S]*?translateX\(-50%\)/.test(css),
  );
  check(`${label}：窗口容器 overflow hidden`, /\.acceptor-ad-window\s*\{[\s\S]*?overflow:\s*hidden/.test(css));
}

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
