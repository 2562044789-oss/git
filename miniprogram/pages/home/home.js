const { decorateTask } = require("../../utils/format");

const app = getApp();

// 首页轮播第 2 张（接单员招募）的按钮文案，按认证进度分档。
// 已经认证的人不该再被反复劝去申请，否则"能接单的人还一直看到申请入口"会很奇怪，
// 所以给他"查看权益"而不是"立即申请"。
const ACCEPTOR_AD_CTA = {
  0: "立即申请",
  1: "查看进度",
  2: "去缴纳",
  3: "查看权益",
  4: "重新提交",
  5: "重新认证",
};

// 取不到认证信息时按"未认证"处理，与后端 fail-closed 的口径保持一致。
function buildAcceptorAd(acceptor) {
  const status = acceptor ? Number(acceptor.status || 0) : 0;
  const deposit = Number((acceptor && acceptor.required_deposit) || 50)
    .toFixed(2)
    .replace(/\.00$/, "");
  return {
    cta: ACCEPTOR_AD_CTA[status] || ACCEPTOR_AD_CTA[0],
    // 轮播第 2 张要单独引用金额，这里一并带出来，避免两处各算一遍
    deposit,
  };
}

Page({
  data: {
    user: null,
    unread: 0,
    categories: [],
    tasks: [],
    announcements: [],
    acceptorAd: buildAcceptorAd(null),
    // 首页轮播当前页与圆点。圆点数量必须和 home.wxml 里 swiper-item 的数量一致。
    heroIndex: 0,
    heroDots: [0, 1, 2],
    loading: true,
  },

  onLoad() {
    this.loadHome();
  },

  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 0 });
    if (!this.data.loading) this.loadHome(true);
  },

  onPullDownRefresh() {
    this.loadHome(true).finally(() => wx.stopPullDownRefresh());
  },

  async loadHome(silent = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const [config, categories, tasks, profile] = await Promise.all([
        app.request({ url: "/api/config", auth: false }),
        app.request({ url: "/api/categories", auth: false }),
        app.request({ url: "/api/tasks?sort=newest&pageSize=4" }),
        app.request({ url: "/api/user/profile" }),
      ]);
      this.setData({
        user: profile,
        unread: profile.stats.unread,
        announcements: config.announcements,
        acceptorAd: buildAcceptorAd(profile.acceptor),
        categories: categories.map((item) => ({
          ...item,
          shortText: item.name.slice(0, 1),
        })),
        tasks: tasks.list.map(decorateTask),
      });
      app.globalData.user = profile;
      app.globalData.unread = profile.stats.unread;
    } finally {
      this.setData({ loading: false });
    }
  },

  goCategories() {
    wx.switchTab({ url: "/pages/tasks/tasks" });
  },

  goTask(event) {
    wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${event.currentTarget.dataset.id}` });
  },

  goMessages() {
    wx.navigateTo({ url: "/pages/messages/messages" });
  },

  goPublish() {
    wx.switchTab({ url: "/pages/publish/publish" });
  },

  goAcceptor() {
    wx.navigateTo({ url: "/pages/acceptor/acceptor" });
  },

  // swiper 的滑动/自动播放都会触发，只用来同步下方圆点
  onHeroChange(event) {
    this.setData({ heroIndex: event.detail.current });
  },

  goCategory(event) {
    wx.setStorageSync("taskCategoryId", event.currentTarget.dataset.id);
    wx.switchTab({ url: "/pages/tasks/tasks" });
  },
});
