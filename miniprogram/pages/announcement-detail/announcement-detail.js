const app = getApp();

// 公告详情页：按 id 单独拉一次接口，
// 这样从首页、列表页、以及未来的分享链接进来都能拿到全文，不依赖上一页有没有缓存。
Page({
  data: {
    loading: true,
    notice: null,
  },

  onLoad(options) {
    this.noticeId = Number(options.id || 0);
    this.loadNotice();
  },

  async loadNotice() {
    if (!this.noticeId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const notice = await app.request({
        url: `/api/announcements/${this.noticeId}`,
        auth: false,
        // 静默失败：404 时页面自己显示「公告不存在」空态，不再叠一层 toast
        silent: true,
      });
      this.setData({
        notice: { ...notice, dateText: String(notice.created_at || "").slice(0, 10) },
      });
    } catch (error) {
      this.setData({ notice: null });
    } finally {
      this.setData({ loading: false });
    }
  },
});
