const app = getApp();

Page({
  data: {
    orderId: null,
    order: null,
    complaints: [],
    formOpen: false,
    submitting: false,
    reasons: ["服务未完成", "物品损坏或丢失", "沟通态度问题", "费用争议", "其他问题"],
    form: {
      reason: "",
      description: "",
      images: [],
    },
  },

  onLoad(options) {
    if (options.orderId) {
      this.setData({ orderId: Number(options.orderId), formOpen: true });
      this.loadOrder();
    } else {
      this.loadComplaints();
    }
  },

  async loadOrder() {
    const order = await app.request({ url: `/api/orders/${this.data.orderId}` });
    this.setData({ order });
  },

  async loadComplaints() {
    const complaints = await app.request({ url: "/api/complaints" });
    const statusMap = {
      0: "待处理",
      1: "处理中",
      2: "已处理",
      3: "已驳回",
    };
    this.setData({
      complaints: complaints.map((item) => ({
        ...item,
        statusText: statusMap[item.status],
        statusClass: item.status === 2 ? "status-green" : item.status === 3 ? "status-gray" : "status-orange",
      })),
    });
  },

  selectReason(event) {
    this.setData({ "form.reason": event.currentTarget.dataset.reason });
  },

  updateDescription(event) {
    this.setData({ "form.description": event.detail.value });
  },

  async chooseImages() {
    const remain = 3 - this.data.form.images.length;
    if (remain <= 0) {
      wx.showToast({ title: "最多上传 3 张凭证", icon: "none" });
      return;
    }
    try {
      const result = await wx.chooseMedia({
        count: remain,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
      });
      wx.showLoading({ title: "凭证上传中", mask: true });
      const uploaded = [];
      for (const file of result.tempFiles) {
        const url = await app.uploadImage(file.tempFilePath);
        uploaded.push(url);
      }
      this.setData({ "form.images": this.data.form.images.concat(uploaded) });
      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      if (error && error.errMsg && error.errMsg.includes("cancel")) return;
      wx.showToast({ title: error.message || "图片上传失败", icon: "none" });
    }
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({
      "form.images": this.data.form.images.filter((_, itemIndex) => itemIndex !== index),
    });
  },

  async submit() {
    if (!this.data.form.reason) return wx.showToast({ title: "请选择投诉原因", icon: "none" });
    if (this.data.form.description.trim().length < 10) {
      return wx.showToast({ title: "请补充至少 10 个字的说明", icon: "none" });
    }
    this.setData({ submitting: true });
    try {
      await app.request({
        url: "/api/complaints",
        method: "POST",
        data: { orderId: this.data.orderId, ...this.data.form },
      });
      wx.showToast({ title: "投诉已提交", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
