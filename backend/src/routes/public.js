// 公开域：无需登录即可访问的只读接口（配置 / 分类 / 公告）。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all, get } = require("../db");
const { HttpError, ok, readPagination } = require("../http");

module.exports = async function handlePublic(req, res, url, ctx) {
  const { method, pathname, serviceFeeRate, rechargeMode, withdrawMode } = ctx;

  if (method === "GET" && pathname === "/api/config") {
    // 首页公告条最多摆 3 条，这里多给 2 条冗余，
    // 避免"刚好第 4 条公告看不到也点不进列表"。
    const announcements = all(
      "SELECT id, title, content, created_at FROM announcements WHERE status = 1 ORDER BY id DESC LIMIT 5",
    );
    // 首页只能摆 3 条，带上总数才能显示「全部 N 条」，
    // 让用户知道后面还有公告没展开，而不是以为管理员的第 4 条丢了。
    const announcementTotal = get(
      "SELECT COUNT(*) AS total FROM announcements WHERE status = 1",
    ).total;
    ok(res, {
      app_name: "阳光社区邻里快办",
      service_fee_rate: serviceFeeRate,
      recharge_mode: rechargeMode,
      withdraw_mode: withdrawMode,
      acceptor_deposit: ctx.ACCEPTOR_DEPOSIT_AMOUNT,
      announcements,
      announcement_total: announcementTotal,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/categories") {
    ok(res, all("SELECT * FROM categories WHERE status = 1 ORDER BY sort, id"));
    return true;
  }

  // 公告列表：公开接口，供「公告中心」页翻看全部启用公告。
  // 首页物理上只放得下 3 条，管理员发的第 4 条以后必须在这里能翻到，
  // 否则新公告等于石沉大海。
  if (method === "GET" && pathname === "/api/announcements") {
    const { page, pageSize } = readPagination(url, 20, 100);
    const total = get(
      "SELECT COUNT(*) AS total FROM announcements WHERE status = 1",
    ).total;
    const list = all(
      `SELECT id, title, content, created_at FROM announcements
       WHERE status = 1 ORDER BY id DESC LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize],
    );
    ok(res, { list, total, page, pageSize });
    return true;
  }

  // 公告详情：列表里其实已经带了 content，
  // 但这个接口让详情页可以按 id 直接刷新/深链，不必依赖列表缓存。
  // status = 1 的条件写在 SQL 里 —— 已下架公告一律 404，不靠调用方过滤。
  const announcementDetailMatch = pathname.match(/^\/api\/announcements\/(\d+)$/);
  if (method === "GET" && announcementDetailMatch) {
    const announcement = get(
      "SELECT id, title, content, created_at FROM announcements WHERE id = ? AND status = 1",
      [Number(announcementDetailMatch[1])],
    );
    if (!announcement) throw new HttpError(404, "公告不存在或已下架");
    ok(res, announcement);
    return true;
  }

  return false;
};
