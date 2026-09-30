const { decorateTask } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    user: null,
    unread: 0,
    categories: [],
    tasks: [],
    announcements: [],
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

  goCategory(event) {
    wx.setStorageSync("taskCategoryId", event.currentTarget.dataset.id);
    wx.switchTab({ url: "/pages/tasks/tasks" });
  },
});
