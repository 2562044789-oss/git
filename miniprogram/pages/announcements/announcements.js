const app = getApp();

// 公告列表页。
// 首页只摆得下 3 条，管理员发的第 4 条起只能靠这一页被看到，
// 所以这里必须把后端全部启用公告一次拉齐，而不是复用 /api/config 的 5 条上限。
Page({
  data: {
    loading: true,
    list: [],
    total: 0,
  },

  onLoad() {
    this.loadAnnouncements();
  },

  onPullDownRefresh() {
    this.loadAnnouncements().then(() => wx.stopPullDownRefresh());
  },

  async loadAnnouncements() {
    try {
      // 公告接口本身是公开的，用 auth:false 免得未登录时被弹回登录页
      const data = await app.request({ url: "/api/announcements?pageSize=50", auth: false });
      this.setData({
        list: (data.list || []).map((item) => ({
          ...item,
          dateText: String(item.created_at || "").slice(0, 10),
        })),
        total: Number(data.total || 0),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goDetail(event) {
    wx.navigateTo({
      url: `/pages/announcement-detail/announcement-detail?id=${event.currentTarget.dataset.id}`,
    });
  },
});
