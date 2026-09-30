const { decorateOrder } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    role: "published",
    status: "",
    orders: [],
    loading: true,
    filterOpen: false,
    activeStatusLabel: "全部订单",
    filters: [
      { value: "", label: "全部" },
      { value: "1", label: "进行中" },
      { value: "2", label: "待确认" },
      { value: "3", label: "已完成" },
      { value: "4", label: "已取消" },
      { value: "5", label: "争议冻结" },
    ],
  },

  onLoad() {
    const role = wx.getStorageSync("orderRole") || "published";
    this.setData({ role });
    this.loadOrders();
  },

  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 3 });
    const role = wx.getStorageSync("orderRole");
    if (role && role !== this.data.role) {
      wx.removeStorageSync("orderRole");
      this.setData({ role });
    }
    this.loadOrders(true);
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  async loadOrders(silent = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const query = [`role=${this.data.role}`, this.data.status ? `status=${this.data.status}` : ""]
        .filter(Boolean)
        .join("&");
      const result = await app.request({ url: `/api/orders?${query}` });
      const orderList = Array.isArray(result) ? result : result.list || [];
      this.setData({ orders: orderList.map(decorateOrder), total: result.total || orderList.length });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchRole(event) {
    this.setData({
      role: event.currentTarget.dataset.role,
      status: "",
      activeStatusLabel: "全部订单",
      filterOpen: false,
    });
    this.loadOrders();
  },

  toggleFilter() {
    this.setData({ filterOpen: !this.data.filterOpen });
  },

  selectStatus(event) {
    const status = event.currentTarget.dataset.value;
    const selected = this.data.filters.find((item) => item.value === status);
    this.setData({
      status,
      activeStatusLabel: selected ? selected.label : "全部订单",
      filterOpen: false,
    });
    this.loadOrders();
  },

  goOrder(event) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${event.currentTarget.dataset.id}` });
  },

  goPublish() {
    wx.switchTab({ url: "/pages/publish/publish" });
  },
});
