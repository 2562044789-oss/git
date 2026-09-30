const app = getApp();

Page({
  data: {
    messages: [],
    type: "",
    filterOpen: false,
    activeTypeLabel: "全部消息",
    filters: [
      { value: "", label: "全部" },
      { value: "2", label: "任务" },
      { value: "3", label: "订单" },
      { value: "4", label: "投诉" },
      { value: "1", label: "系统" },
    ],
  },

  onLoad() {
    this.loadMessages();
  },

  onPullDownRefresh() {
    this.loadMessages().finally(() => wx.stopPullDownRefresh());
  },

  async loadMessages() {
    const query = this.data.type ? `?type=${this.data.type}` : "";
    const messages = await app.request({ url: `/api/messages${query}` });
    this.setData({
      messages: messages.map((item) => ({
        ...item,
        typeText: { 1: "系统", 2: "任务", 3: "订单", 4: "投诉" }[Number(item.type)] || "通知",
      })),
    });
  },

  toggleFilter() {
    this.setData({ filterOpen: !this.data.filterOpen });
  },

  selectType(event) {
    const type = event.currentTarget.dataset.value;
    const selected = this.data.filters.find((item) => item.value === type);
    this.setData({
      type,
      activeTypeLabel: selected ? selected.label : "全部消息",
      filterOpen: false,
    });
    this.loadMessages();
  },

  async readMessage(event) {
    const id = Number(event.currentTarget.dataset.id);
    const message = this.data.messages.find((item) => Number(item.id) === id);
    if (message && !message.is_read) {
      await app.request({ url: `/api/messages/${id}/read`, method: "POST" });
      this.loadMessages();
    }
  },

  async readAll() {
    await app.request({ url: "/api/messages/read-all", method: "POST" });
    wx.showToast({ title: "已全部标为已读", icon: "success" });
    this.loadMessages();
  },
});
