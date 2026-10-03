const { decorateOrder } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    role: "published",
    status: "",
    orders: [],
    total: 0,
    loading: true,
    page: 1,
    pageSize: 10,
    hasMore: false,
    loadingMore: false,
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

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadMoreOrders();
  },

  buildOrderQuery() {
    return [
      `role=${this.data.role}`,
      this.data.status ? `status=${this.data.status}` : "",
      `page=${this.data.page}`,
      `pageSize=${this.data.pageSize}`,
    ]
      .filter(Boolean)
      .join("&");
  },

  async loadOrders(silent = false) {
    const patch = { page: 1 };
    if (!silent) patch.loading = true;
    this.setData(patch);
    try {
      const result = await app.request({ url: `/api/orders?${this.buildOrderQuery()}` });
      const orderList = Array.isArray(result) ? result : result.list || [];
      const total = Number(result.total || orderList.length);
      // 原先这里连续两次 setData（列表一次、loading 一次），合并减少一次跨线程通信
      this.setData({
        orders: orderList.map(decorateOrder),
        total,
        hasMore: orderList.length < total,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMoreOrders() {
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    try {
      const result = await app.request({ url: `/api/orders?${this.buildOrderQuery()}` });
      const orderList = Array.isArray(result) ? result : result.list || [];
      const total = Number(result.total || orderList.length);
      const orders = this.data.orders.concat(orderList.map(decorateOrder));
      this.setData({
        orders,
        total,
        hasMore: orders.length < total,
      });
    } finally {
      this.setData({ loadingMore: false });
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
