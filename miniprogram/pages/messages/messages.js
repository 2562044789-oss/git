const app = getApp();

Page({
  data: {
    messages: [],
    type: "",
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
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

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadMoreMessages();
  },

  buildMessageQuery() {
    const parts = [`page=${this.data.page}`, `pageSize=${this.data.pageSize}`];
    if (this.data.type) parts.push(`type=${this.data.type}`);
    return `?${parts.join("&")}`;
  },

  decorate(batch) {
    return batch.map((item) => ({
      ...item,
      typeText: { 1: "系统", 2: "任务", 3: "订单", 4: "投诉" }[Number(item.type)] || "通知",
    }));
  },

  async loadMessages() {
    this.setData({ page: 1 });
    const batch = await app.request({ url: `/api/messages${this.buildMessageQuery()}` });
    // 消息接口返回数组、不带 total：本批拉满一页就认为还有下一页
    this.setData({
      messages: this.decorate(batch),
      hasMore: batch.length === this.data.pageSize,
    });
  },

  async loadMoreMessages() {
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    try {
      const batch = await app.request({ url: `/api/messages${this.buildMessageQuery()}` });
      this.setData({
        messages: this.data.messages.concat(this.decorate(batch)),
        hasMore: batch.length === this.data.pageSize,
      });
    } finally {
      this.setData({ loadingMore: false });
    }
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
