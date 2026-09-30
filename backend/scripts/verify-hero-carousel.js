// 校验首页「广告轮播」的数据与结构。
//
// 轮播逻辑写在前端 app.js 里、没法 require，所以把相关代码原样切出来求值，
// 确保测的是真实上线的那段代码而不是副本。除文案外还守住几条容易悄悄坏掉的不变量：
//   - 每张标题必须能排成 2 行（7 个汉字以内）—— 390px 真机宽度下超过就会折成 3 行；
//   - 样式里不能残留旧的 .hero 选择器（hero 改名成 hero-slide 时留下过两个漏网的）；
//   - 小程序 swiper 必须有明确高度、圆点数量必须和 swiper-item 数量一致。
const fs = require("node:fs");
const path = require("node:path");

const previewDir = path.join(__dirname, "..", "public", "preview");
const previewApp = path.join(previewDir, "app.js");
const previewCss = path.join(previewDir, "styles.css");
const homeDir = path.join(__dirname, "..", "..", "miniprogram", "pages", "home");
const miniJs = path.join(homeDir, "home.js");
const miniWxml = path.join(homeDir, "home.wxml");
const miniWxss = path.join(homeDir, "home.wxss");

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

// ---- 预览端：把轮播的文案与标记函数真求值 ----
// 切片从 ACCEPTOR_AD_CTA 开始，因为 heroSlides() 复用了 acceptorCta() 的按钮文案。
const previewSource = fs.readFileSync(previewApp, "utf8");
const previewSnippet = extract(
  previewSource,
  "const ACCEPTOR_AD_CTA",
  "function statusMeta(",
);
// 顶替模块作用域里的 acceptorOf（读认证状态）与 escapeHtml
const previewFactory = new Function(
  "acceptorOf",
  "escapeHtml",
  `${previewSnippet}\nreturn { heroSlides, heroScene, heroSlideMarkup };`,
);
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const buildSlides = (acceptor) =>
  previewFactory(() => acceptor, escapeHtml).heroSlides();

console.log("== 预览端：轮播数据 ==");
const DEFAULT = { status: 0, required_deposit: 50 };
const slides = buildSlides(DEFAULT);

check("恰好 3 张广告", slides.length === 3, `→ ${slides.length} 张`);
check(
  "三张的 key / 底色 / 插画各不相同（滑动时能明确区分）",
  new Set(slides.map((s) => s.key)).size === 3 &&
    new Set(slides.map((s) => s.theme)).size === 3 &&
    new Set(slides.map((s) => s.scene)).size === 3,
);
for (const [index, slide] of slides.entries()) {
  check(
    `第 ${index + 1} 张字段完整（eyebrow / 标题 / 正文 / 按钮）`,
    Boolean(slide.eyebrow && slide.title && slide.copy && slide.cta),
    `→ ${slide.key}`,
  );
  check(
    `第 ${index + 1} 张文案无未替换占位符`,
    !slide.title.includes("{") && !slide.copy.includes("{"),
    `→ ${slide.copy}`,
  );
}

// 标题必须正好一行两段，且每段 ≤ 7 个字符：
// 文案列宽是卡片的 64%，390px 真机宽度下 7 个字 × 25px ≈ 175px 刚好放得下，
// 超过就会折成 3 行（这个 bug 就是在截图上发现的）。
for (const [index, slide] of slides.entries()) {
  const lines = slide.title.split("<br>").map((line) => line.trim());
  check(
    `第 ${index + 1} 张标题为两行且每行不超过 7 字`,
    lines.length === 2 && lines.every((line) => line.length > 0 && line.length <= 7),
    `→ ${lines.map((line) => `${line}(${line.length})`).join(" | ")}`,
  );
}

console.log("== 预览端：按钮去向与认证状态联动 ==");
const markupOf = (acceptor) => {
  const factory = previewFactory(() => acceptor, escapeHtml);
  const list = factory.heroSlides();
  return list.map((slide, index) => factory.heroSlideMarkup(slide, index, list.length));
};
const defaultMarkup = markupOf(DEFAULT);
check("第 1 张按钮去发布页", defaultMarkup[0].includes('data-view="publish"'));
check("第 2 张按钮去接单员认证", defaultMarkup[1].includes('data-action="acceptor"'));
check("第 3 张按钮去任务大厅", defaultMarkup[2].includes('data-view="tasks"'));
check(
  "深绿底用白底按钮、米色底用琥珀按钮（否则按钮会糊在底色里）",
  defaultMarkup[1].includes("hero-button invert") &&
    defaultMarkup[2].includes("hero-button amber") &&
    !defaultMarkup[0].includes("hero-button invert"),
);

// 第 2 张的 CTA 必须跟着认证进度走：已认证的人不该再被劝去申请
const CTA_BY_STATUS = {
  0: "立即申请",
  1: "查看进度",
  2: "去缴纳",
  3: "查看权益",
  4: "重新提交",
  5: "重新认证",
};
for (const [status, cta] of Object.entries(CTA_BY_STATUS)) {
  const slide = buildSlides({ status: Number(status), required_deposit: 50 })[1];
  check(`status=${status} 第 2 张 CTA = ${cta}`, slide.cta === cta, `→ ${slide.cta}`);
}
check(
  "无认证信息时按未认证兜底",
  buildSlides(null)[1].cta === "立即申请",
  `→ ${buildSlides(null)[1].cta}`,
);
check(
  "保证金金额跟随配置（第 2 张正文）",
  buildSlides({ status: 0, required_deposit: 100 })[1].copy.includes("100") &&
    buildSlides(DEFAULT)[1].copy.includes("50"),
);

console.log("== 预览端：样式不变量 ==");
const previewCssText = fs.readFileSync(previewCss, "utf8");
check(
  "轨道用 scroll-snap 实现横向分页",
  /\.hero-track\s*\{[\s\S]*?scroll-snap-type:\s*x mandatory/.test(previewCssText),
);
check(
  "每张占满一屏且一次只翻一页",
  /\.hero-slide\s*\{[\s\S]*?flex:\s*0 0 100%/.test(previewCssText) &&
    /\.hero-slide\s*\{[\s\S]*?scroll-snap-align:\s*start/.test(previewCssText) &&
    /\.hero-slide\s*\{[\s\S]*?scroll-snap-stop:\s*always/.test(previewCssText),
);
check(
  "圆点做在卡片内、带白色托底胶囊（三种底色都要看得清）",
  /\.hero-dot-pill\s*\{/.test(previewCssText) && /\.hero-dot\.active\s*\{/.test(previewCssText),
);
// hero 从 .hero 改名成 .hero-slide 时漏掉过两个选择器（窄屏媒体查询里的 h2），
// 残留会让字号规则静默失效，这里直接挡住。
check(
  "没有残留的旧 .hero 选择器",
  !/^\s*\.hero\s*[{,]/m.test(previewCssText) && !/^\s*\.hero\s+(h2|p)\b/m.test(previewCssText),
);
check(
  "窄屏断点里收紧了标题字号（防 3 行折行回归）",
  /@media \(max-width: 430px\)\s*\{[\s\S]*?\.hero-slide h2\s*\{[\s\S]*?font-size:\s*25px/.test(
    previewCssText,
  ),
);

console.log("== 小程序端：swiper 结构 ==");
const wxml = fs.readFileSync(miniWxml, "utf8");
const wxss = fs.readFileSync(miniWxss, "utf8");
const miniSource = fs.readFileSync(miniJs, "utf8");

check("使用原生 swiper 承载轮播", /<swiper\b/.test(wxml));
check(
  "swiper 开启循环、自动播放并回传页码",
  /autoplay="\{\{true\}\}"/.test(wxml) &&
    /circular="\{\{true\}\}"/.test(wxml) &&
    /bindchange="onHeroChange"/.test(wxml),
);
const swiperItems = wxml.match(/<swiper-item>/g) || [];
check("swiper-item 恰好 3 个", swiperItems.length === 3, `→ ${swiperItems.length} 个`);

// 圆点数量必须等于 swiper-item 数量，否则滑到后面圆点就不动了
const heroDots = (miniSource.match(/heroDots:\s*\[([^\]]*)\]/) || [])[1] || "";
const dotCount = heroDots.split(",").filter((item) => item.trim()).length;
check(
  "圆点数量与 swiper-item 数量一致",
  dotCount === swiperItems.length,
  `→ 圆点 ${dotCount} / 卡片 ${swiperItems.length}`,
);
check(
  "圆点跟随当前页高亮",
  /class="hero-dot \{\{heroIndex === item \? 'active' : ''\}\}"/.test(wxml) &&
    /onHeroChange\(event\)\s*\{[\s\S]*?setData\(\{\s*heroIndex: event\.detail\.current/.test(miniSource),
);
// swiper 不会按内容自适应高度，漏了 height 会整块塌成 0
check(
  "swiper 有明确高度（不然卡片会塌陷）",
  /\.hero-swiper\s*\{[\s\S]*?height:\s*\d+rpx/.test(wxss),
);
check(
  "三张各自有独立底色",
  ["publish", "earn", "safe"].every((name) =>
    new RegExp(`\\.hero-band-${name}\\s*\\{`).test(wxss),
  ) &&
    wxml.includes("hero-band-publish") &&
    wxml.includes("hero-band-earn") &&
    wxml.includes("hero-band-safe"),
);
check(
  "第 2 张的按钮文案取自认证状态，第 3 张去任务大厅",
  /\{\{acceptorAd\.cta\}\}/.test(wxml) && /bindtap="goCategories"/.test(wxml),
);
check(
  "第 2 张用到的保证金金额已由 buildAcceptorAd 带出",
  /return\s*\{[\s\S]*?deposit,/.test(
    extract(miniSource, "function buildAcceptorAd", "Page({"),
  ) && /\{\{acceptorAd\.deposit\}\}/.test(wxml),
);

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
