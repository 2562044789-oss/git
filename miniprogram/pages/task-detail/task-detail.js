const { decorateTask } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    id: null,
    task: null,
    loading: true,
    accepting: false,
    isPublisher: false,
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) });
    this.loadTask();
  },

  onPullDownRefresh() {
    this.loadTask().finally(() => wx.stopPullDownRefresh());
  },

  async loadTask() {
    this.setData({ loading: true });
    try {
      const task = await app.request({ url: `/api/tasks/${this.data.id}` });
      const user = app.globalData.user || (await app.ensureLogin());
      this.setData({
        task: decorateTask(task),
        isPublisher: Number(task.publisher_id) === Number(user.id),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async acceptTask() {
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "确认接单",
        content: `接单后请按约定时间完成服务，报酬 ¥${Number(this.data.task.reward).toFixed(2)} 将暂时托管。`,
        confirmText: "确认接单",
        success: (result) => resolve(result.confirm),
      });
    });
    if (!confirmed) return;
    this.setData({ accepting: true });
    try {
      const order = await app.request({
        url: `/api/tasks/${this.data.id}/accept`,
        method: "POST",
      });
      wx.showToast({ title: "接单成功", icon: "success" });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${order.id}` });
      }, 500);
    } catch (error) {
      // 未完成实名认证 / 未缴保证金时后端返回 403，直接引导到认证页，
      // 顺带把后端给出的具体原因（缺哪一步）带过去提示用户。
      if (Number(error.statusCode) === 403) {
        this.goCertify();
      }
    } finally {
      this.setData({ accepting: false });
    }
  },

  goCertify() {
    wx.navigateTo({ url: "/pages/acceptor/acceptor" });
  },

  cancelTask() {
    wx.showModal({
      title: "取消任务",
      content: "取消后托管报酬将退回余额，确认继续吗？",
      confirmColor: "#d75f5f",
      success: async (result) => {
        if (!result.confirm) return;
        await app.request({
          url: `/api/tasks/${this.data.id}/cancel`,
          method: "POST",
          data: { reason: "发布者主动取消" },
        });
        wx.showToast({ title: "任务已取消", icon: "success" });
        this.loadTask();
      },
    });
  },

  contactPublisher() {
    if (!this.data.task.can_contact) {
      wx.showToast({ title: "接单后才能查看完整联系方式", icon: "none" });
      return;
    }
    wx.showModal({
      title: `${this.data.task.contact_name} 的联系方式`,
      content: `${this.data.task.contact_phone}\n接单后请通过电话或站内消息联系。`,
      showCancel: false,
      confirmText: "知道了",
    });
  },
});
