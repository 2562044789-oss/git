const { decorateOrder } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    id: null,
    order: null,
    user: null,
    timeline: [],
    isPublisher: false,
    isAcceptor: false,
    reviewed: false,
    actionLoading: false,
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) });
  },

  onShow() {
    this.loadOrder();
  },

  onPullDownRefresh() {
    this.loadOrder().finally(() => wx.stopPullDownRefresh());
  },

  async loadOrder() {
    const [order, user] = await Promise.all([
      app.request({ url: `/api/orders/${this.data.id}` }),
      app.request({ url: "/api/user/profile" }),
    ]);
    const decorated = decorateOrder(order);
    const reviewed = order.reviews.some((item) => Number(item.reviewer_id) === Number(user.id));
    this.setData({
      order: decorated,
      user,
      isPublisher: Number(order.publisher_id) === Number(user.id),
      isAcceptor: Number(order.acceptor_id) === Number(user.id),
      reviewed,
      timeline: this.buildTimeline(order),
    });
  },

  buildTimeline(order) {
    const current = Number(order.status);
    const taskStatus = Number(order.task_status);
    return [
      { title: "接单成功", time: order.created_at, done: current >= 1 },
      { title: "开始服务", time: "", done: current >= 2 || taskStatus >= 2 },
      { title: "提交完成", time: order.finished_at, done: taskStatus >= 3 },
      { title: "确认结算", time: order.confirm_time, done: current >= 3 },
    ];
  },

  async runAction(url, data, successText) {
    this.setData({ actionLoading: true });
    try {
      await app.request({ url, method: "POST", data });
      wx.showToast({ title: successText, icon: "success" });
      await this.loadOrder();
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  startService() {
    this.runAction(`/api/orders/${this.data.id}/start`, {}, "服务已开始");
  },

  finishService() {
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      sizeType: ["compressed"],
      success: async (result) => {
        const paths = result.tempFiles.map((item) => item.tempFilePath);
        if (!paths.length) return;
        wx.showLoading({ title: "凭证上传中", mask: true });
        try {
          // 逐张上传到服务器，只提交可公开访问的 URL，避免 base64 撑大请求体
          const images = [];
          for (const path of paths) {
            images.push(await app.uploadImage(path));
          }
          wx.hideLoading();
          const confirmed = await new Promise((resolve) => {
            wx.showModal({
              title: "确认完成任务",
              content: `已上传 ${images.length} 张完成凭证，提交后将等待发布者确认。`,
              confirmText: "确认完成",
              success: (modalResult) => resolve(modalResult.confirm),
              fail: () => resolve(false),
            });
          });
          if (!confirmed) return;
          await this.runAction(
            `/api/orders/${this.data.id}/finish`,
            { images },
            "已提交，等待发布者确认",
          );
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || "凭证上传失败，请重试", icon: "none" });
        }
      },
    });
  },

  previewCompletion(event) {
    const urls = this.data.order.completion_images || [];
    wx.previewImage({ current: urls[Number(event.currentTarget.dataset.index)], urls });
  },

  confirmOrder() {
    wx.showModal({
      title: "确认订单完成",
      content: "确认后托管报酬将结算给接单邻居，此操作不可撤销。",
      confirmText: "确认完成",
      success: (result) => {
        if (result.confirm) this.runAction(`/api/orders/${this.data.id}/confirm`, {}, "订单已完成");
      },
    });
  },

  cancelOrder() {
    wx.showModal({
      title: "申请取消订单",
      editable: true,
      placeholderText: "填写取消原因",
      confirmColor: "#d75f5f",
      success: (result) => {
        if (result.confirm) {
          this.runAction(
            `/api/orders/${this.data.id}/cancel`,
            { reason: result.content || "双方协商取消" },
            "订单已取消",
          );
        }
      },
    });
  },

  goReview() {
    wx.navigateTo({ url: `/pages/reviews/reviews?orderId=${this.data.id}` });
  },

  goComplaint() {
    wx.navigateTo({ url: `/pages/complaints/complaints?orderId=${this.data.id}` });
  },

  contactPerson() {
    const contact = this.data.isPublisher
      ? { name: this.data.order.acceptor_name, phone: this.data.order.acceptor_phone }
      : { name: this.data.order.publisher_name, phone: this.data.order.publisher_phone };
    wx.showModal({
      title: `${contact.name} 的联系方式`,
      content: contact.phone || "对方暂未填写联系电话",
      showCancel: false,
    });
  },
});
