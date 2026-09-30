// 社区公告的回归校验。
//
// 修复背景（用户反馈）：
//   1. 只能看到标题，点不进正文；
//   2. 只能看到一条，管理员发第 2 条起前台完全看不到。
// 根因是三处叠加：后端 /api/config 写死 LIMIT 3、预览页取 announcements[0]、
// 小程序首页写死 {{announcements[0].title}} 且那一行根本没有点击事件。
//
// 后续又补了口子：后台补上发布能力后仍只能"发"，发错了既不能改也不能撤。
//
// 这个脚本从两侧把结论钉住：
//   A. 起真后端，连发 4 条公告，验证接口层"发多少就能读到多少"；
//   B. 从 preview/app.js 里切出真实的渲染函数求值（不是抄一份副本），
//      验证首页公告条确实可点击、公告卡片确实带正文；
//   C. 对小程序 wxml/js/json 做结构断言，包括"不许再出现 announcements[0]"；
//   D. 真实 HTTP 打一遍撤回链路：改文案 → 下架（前台列表/详情/计数同步消失）
//      → 重新发布 → 删除，外加非法入参防御、审计留痕与管理后台按钮绑定。
//
// 跑法：node --no-warnings scripts/verify-announcements.js
// 用临时库 + 独立端口，不碰演示数据。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3016;
const BASE = `http://127.0.0.1:${PORT}`;
const BACKEND = path.join(__dirname, "..");
const ROOT = path.join(BACKEND, "..");
const DB = path.join(os.tmpdir(), `announcements-${Date.now()}.sqlite`);

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

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

// 从源码里切出顶层函数原文：函数体内部的缩进块不会以行首 "}" 结束，
// 所以第一个行首 "}" 就是该函数的结尾。
function extractFunction(source, name) {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"));
  return match ? match[0] : "";
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

const ADMIN_APP = read("backend/public/admin/app.js");
const PREVIEW_APP = read("backend/public/preview/app.js");
const PREVIEW_CSS = read("backend/public/preview/styles.css");
const HOME_WXML = read("miniprogram/pages/home/home.wxml");
const HOME_JS = read("miniprogram/pages/home/home.js");
const APP_JSON = read("miniprogram/app.json");

const escapeForTest = (value) =>
  String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
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

    console.log("== A. 接口层：管理员发多少，前台就能读到多少 ==");
    const seeded = await api("GET", "/api/announcements");
    const baseTotal = Number(seeded.body.data.total);
    check(`种子公告可读（${baseTotal} 条）`, baseTotal >= 2, `→ total=${baseTotal}`);

    const adminLogin = await api("POST", "/api/admin/login", {
      username: "admin",
      password: "admin123",
    });
    const adminToken = adminLogin.body.data.token;

    const titles = [];
    for (let i = 1; i <= 4; i += 1) {
      const title = `压测公告 ${i}`;
      titles.push(title);
      await api(
        "POST",
        "/api/admin/announcements",
        { title, content: `第 ${i} 条公告的正文内容。` },
        adminToken,
      );
    }

    const all = await api("GET", "/api/announcements");
    const allTitles = all.body.data.list.map((item) => item.title);
    check(
      `连发 4 条后列表返回 ${baseTotal + 4} 条（不再是 3 条封顶）`,
      Number(all.body.data.total) === baseTotal + 4,
      `→ total=${all.body.data.total}`,
    );
    for (const title of titles) {
      check(`「${title}」能被前台读到`, allTitles.includes(title));
    }

    const config = await api("GET", "/api/config");
    check(
      "/api/config 带回公告总数，供首页显示「全部 N 条」",
      Number(config.body.data.announcement_total) === baseTotal + 4,
      `→ announcement_total=${config.body.data.announcement_total}`,
    );
    check(
      "首页下发条数收敛（不超过 5 条），不会随公告数无限膨胀",
      config.body.data.announcements.length <= 5,
      `→ ${config.body.data.announcements.length} 条`,
    );

    const target = all.body.data.list[0];
    const detail = await api("GET", `/api/announcements/${target.id}`);
    check("公告详情未登录即可读全文", detail.status === 200 && Boolean(detail.body.data.content));
    const missing = await api("GET", "/api/announcements/999999");
    check("不存在的公告返回 404", missing.status === 404, `→ ${missing.status}`);

    console.log("\n== B. 预览页：渲染函数从真实源码中切出来求值 ==");
    const snippets = ["shortDate", "announcementRow", "announcementCard"].map((name) =>
      extractFunction(PREVIEW_APP, name),
    );
    check("preview/app.js 中存在公告渲染函数", snippets.every((code) => code.length > 0));

    if (snippets.every((code) => code.length > 0)) {
      const sandbox = new Function(
        "escapeHtml",
        `${snippets.join("\n")}
         return { shortDate, announcementRow, announcementCard };`,
      )(escapeForTest);

      const row = sandbox.announcementRow({
        id: 7,
        title: "周末便民服务",
        created_at: "2026-09-30 15:31:57",
      });
      check("首页公告条带 data-announcement，说明它真的可点击", row.includes('data-announcement="7"'));
      check("首页公告条同时给出标题与日期", row.includes("周末便民服务") && row.includes("2026-09-30"));
      check("时间不再原样显示到秒", !row.includes("15:31:57"));

      const card = sandbox.announcementCard({
        id: 1,
        title: "文明跑腿提醒",
        content: "请邻里之间保持友好沟通，按约完成服务并及时确认订单。",
        created_at: "2026-09-30 15:31:57",
      });
      check("公告中心卡片直接铺出正文，不用再点开", card.includes("请邻里之间保持友好沟通"));

      const unsafe = sandbox.announcementCard({
        id: 2,
        title: "<img src=x onerror=alert(1)>",
        content: "<script>alert(1)</script>",
        created_at: "2026-09-30 15:31:57",
      });
      check(
        "公告文案经过转义，不会把 HTML 注进页面",
        !unsafe.includes("<img") && !unsafe.includes("<script"),
      );
    }

    check(
      "首页仍保留「全部 N 条」入口指向公告中心",
      /data-view="announcements"/.test(PREVIEW_APP),
    );
    check("preview/app.js 已实现公告中心视图", /async function renderAnnouncements\(/.test(PREVIEW_APP));
    check(
      "公告中心调用独立列表接口而非复用 /api/config 的 5 条",
      /api\("\/api\/announcements\?pageSize=50"\)/.test(PREVIEW_APP),
    );
    check(
      "预览页 CSS 定义了公告卡片与正文样式",
      /\.announcement-card-body\s*\{/.test(PREVIEW_CSS) && /\.announcement-item\s*\{/.test(PREVIEW_CSS),
    );
    check(
      "旧的一行式公告样式已清除，不留死代码",
      !/\.announcement-text\s*\{/.test(PREVIEW_CSS) && !/class="announcement-text"/.test(PREVIEW_APP),
    );

    console.log("\n== C. 小程序：结构断言 ==");
    check(
      "首页不再写死 announcements[0]",
      !/announcements\[0\]/.test(HOME_WXML) && !/announcements\[0\]/.test(HOME_JS),
    );
    check("首页用 wx:for 遍历公告列表", /wx:for="\{\{announcements\}\}"/.test(HOME_WXML));
    check(
      "首页公告条绑定 goAnnouncement，不再是死标签",
      /bindtap="goAnnouncement"/.test(HOME_WXML) && /goAnnouncement\(event\)/.test(HOME_JS),
    );
    check(
      "首页有「全部 N 条」入口",
      /bindtap="goAnnouncements"/.test(HOME_WXML) && /goAnnouncements\(\)/.test(HOME_JS),
    );
    check(
      "home.js 用后端总数而非数组长度显示条数",
      /announcement_total/.test(HOME_JS),
    );

    const pages = ["pages/announcements/announcements", "pages/announcement-detail/announcement-detail"];
    for (const page of pages) {
      check(`app.json 已注册 ${page}`, APP_JSON.includes(`"${page}"`));
    }

    for (const page of pages) {
      const dir = path.join(ROOT, "miniprogram", page);
      const missing = [".js", ".json", ".wxml", ".wxss"].filter(
        (ext) => !fs.existsSync(dir + ext),
      );
      check(`${page} 四个文件齐全`, missing.length === 0, `→ 缺 ${missing.join(", ")}`);
    }

    const listWxml = read("miniprogram/pages/announcements/announcements.wxml");
    const listJs = read("miniprogram/pages/announcements/announcements.js");
    const detailWxml = read("miniprogram/pages/announcement-detail/announcement-detail.wxml");

    check("公告列表页调用独立列表接口", /\/api\/announcements\?pageSize=50/.test(listJs));
    check("公告列表页每条可点进详情", /bindtap="goDetail"/.test(listWxml));
    check("公告详情页输出完整正文", /\{\{notice\.content\}\}/.test(detailWxml));
    check(
      "公告详情页用独立详情接口按 id 拉取",
      /\/api\/announcements\/\$\{this\.noticeId\}/.test(
        read("miniprogram/pages/announcement-detail/announcement-detail.js"),
      ),
    );

    // ---------------------------------------------------------------
    // D. 撤回链路：此前后台只能"发"，发错了既不能改也不能撤。
    //    这一节把"改文案 / 下架 / 重新发布 / 删除"四种动作的真实 HTTP 行为钉住。
    // ---------------------------------------------------------------
    console.log("\n== D. 后台撤回：改文案 / 下架 / 重发 / 删除 ==");

    const created = await api(
      "POST",
      "/api/admin/announcements",
      { title: "待撤回公告", content: "这条公告用来验证后台能不能撤回。" },
      adminToken,
    );
    const noticeId = created.body.data.id;
    check("新建公告成功并返回 id", Number.isInteger(noticeId) || Boolean(noticeId));

    // D1. 只改文案：状态必须原样保持"已发布"，不能顺手把它撤了。
    const edited = await api(
      "PUT",
      `/api/admin/announcements/${noticeId}`,
      { title: "已改标题", content: "改过之后的正文。" },
      adminToken,
    );
    check(
      "改文案返回 200 且标题已更新",
      edited.status === 200 && edited.body.data.title === "已改标题",
      `→ ${edited.status}`,
    );
    check(
      "只改文案不会误改发布状态（仍是已发布）",
      Number(edited.body.data.status) === 1,
      `→ status=${edited.body.data.status}`,
    );
    const stillOnline = await api("GET", `/api/announcements/${noticeId}`);
    check("改完文案前台立即能看到新标题", stillOnline.body.data.title === "已改标题");

    // D2. 下架：前台列表、详情、首页计数三处都要立刻消失。
    const beforeUnpublish = await api("GET", "/api/announcements");
    const totalBefore = Number(beforeUnpublish.body.data.total);
    const unpublish = await api(
      "PUT",
      `/api/admin/announcements/${noticeId}`,
      { status: 0 },
      adminToken,
    );
    check("下架返回 200", unpublish.status === 200, `→ ${unpublish.status}`);
    check("下架后该公告状态为 0", Number(unpublish.body.data.status) === 0);

    const afterUnpublish = await api("GET", "/api/announcements");
    check(
      "下架后不再出现在前台列表",
      !afterUnpublish.body.data.list.some((item) => Number(item.id) === Number(noticeId)),
    );
    check(
      "下架后前台总数减 1",
      Number(afterUnpublish.body.data.total) === totalBefore - 1,
      `→ ${afterUnpublish.body.data.total}`,
    );
    const goneDetail = await api("GET", `/api/announcements/${noticeId}`);
    check("下架后详情接口返回 404（下架即不可深链）", goneDetail.status === 404, `→ ${goneDetail.status}`);

    const adminList = await api("GET", "/api/admin/announcements", null, adminToken);
    const inAdminList = adminList.body.data.find((item) => Number(item.id) === Number(noticeId));
    check("下架后后台列表仍留着这条（status=0），方便重新发布", Number(inAdminList?.status) === 0);
    check("后台列表把 status 一并下发，前端才能区分已发布/已下架", "status" in (inAdminList || {}));

    // D3. 重新发布：回到前台。
    const republish = await api(
      "PUT",
      `/api/admin/announcements/${noticeId}`,
      { status: 1 },
      adminToken,
    );
    check("重新发布返回 200", republish.status === 200);
    const backOnline = await api("GET", `/api/announcements/${noticeId}`);
    check("重新发布后前台又能读到", backOnline.status === 200, `→ ${backOnline.status}`);

    // D4. 入参防御：非法状态 / 空标题 / 不存在的 id 都不能写库。
    const badStatus = await api(
      "PUT",
      `/api/admin/announcements/${noticeId}`,
      { status: 5 },
      adminToken,
    );
    check("非法状态值返回 400", badStatus.status === 400, `→ ${badStatus.status}`);
    const emptyTitle = await api(
      "PUT",
      `/api/admin/announcements/${noticeId}`,
      { title: "   " },
      adminToken,
    );
    check("标题留空返回 400，不会被清库", emptyTitle.status === 400, `→ ${emptyTitle.status}`);
    const ghost = await api("PUT", "/api/admin/announcements/999999", { status: 0 }, adminToken);
    check("修改不存在的公告返回 404", ghost.status === 404, `→ ${ghost.status}`);

    // D5. 删除：彻底移除，且需要管理员身份。
    const delGhost = await api("DELETE", "/api/admin/announcements/999999", null, adminToken);
    check("删除不存在的公告返回 404", delGhost.status === 404, `→ ${delGhost.status}`);
    const unauth = await api("DELETE", `/api/admin/announcements/${noticeId}`);
    check("未登录不能删除公告（401/403）", [401, 403].includes(unauth.status), `→ ${unauth.status}`);

    const del = await api("DELETE", `/api/admin/announcements/${noticeId}`, null, adminToken);
    check("删除已发布公告返回 200", del.status === 200, `→ ${del.status}`);
    const adminAfterDelete = await api("GET", "/api/admin/announcements", null, adminToken);
    check(
      "删除后后台列表里也没有了",
      !adminAfterDelete.body.data.some((item) => Number(item.id) === Number(noticeId)),
    );
    const detailAfterDelete = await api("GET", `/api/announcements/${noticeId}`);
    check("删除后详情接口 404", detailAfterDelete.status === 404);

    // D6. 前端结构：三个操作按钮必须真的存在且绑到了对应动作。
    console.log("\n== D'. 后台前端：按钮与事件绑定 ==");
    check(
      "公告卡片带「编辑」按钮",
      /data-edit-announcement="\$\{announcement\.id\}"/.test(ADMIN_APP),
    );
    check(
      "公告卡片带「下架/重新发布」按钮",
      /data-announcement-status="\$\{announcement\.id\}"/.test(ADMIN_APP),
    );
    check(
      "公告卡片带「删除」按钮",
      /data-delete-announcement="\$\{announcement\.id\}"/.test(ADMIN_APP),
    );
    check(
      "下架按钮走 PUT，且只提交 status（不会顺手把正文清空）",
      /method: "PUT",\s*\n\s*body: \{ status: nextStatus \}/.test(ADMIN_APP),
    );
    check("删除按钮走 DELETE", /method: "DELETE"/.test(ADMIN_APP));
    check(
      "删除前有二次确认，避免手滑",
      /window\.confirm\(`确定彻底删除公告/.test(ADMIN_APP),
    );
    check(
      "编辑器支持编辑模式（传参回填标题）",
      /function openAnnouncementEditor\(announcement = null\)/.test(ADMIN_APP) &&
        /value="\$\{escapeHtml\(announcement\?\.title \|\| ""\)\}"/.test(ADMIN_APP),
    );
    check(
      "保存按钮按有无 id 区分 POST/PUT",
      /data-save-announcement="\$\{announcement\?\.id \|\| ""\}"/.test(ADMIN_APP) &&
        /method: id \? "PUT" : "POST"/.test(ADMIN_APP),
    );
    check(
      "已下架公告在后台显示为「已下架」而非「已发布」",
      /published \? "已发布" : "已下架"/.test(ADMIN_APP),
    );

    // D7. 审计：发布 / 改 / 删都要留痕，且日志页能翻译成中文。
    const logs = await api("GET", "/api/admin/logs?pageSize=50", null, adminToken);
    const actions = logs.body.data.list.map((item) => item.action);
    check("发布公告已写入操作日志", actions.includes("publish_announcement"));
    check("修改/下架公告已写入操作日志", actions.includes("update_announcement"));
    check("删除公告已写入操作日志", actions.includes("delete_announcement"));
    for (const [key, label] of [
      ["publish_announcement", "发布公告"],
      ["update_announcement", "修改/上下架公告"],
      ["delete_announcement", "删除公告"],
    ]) {
      check(
        `日志页能把 ${key} 显示为中文`,
        new RegExp(`${key}: "${label}"`).test(ADMIN_APP),
      );
    }
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
