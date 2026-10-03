const { decorateTask } = require("../../utils/format");

const app = getApp();

Page({
  data: {
    categories: [],
    categoryId: 0,
    keyword: "",
    sort: "newest",
    tasks: [],
    total: 0,
    loading: true,
    page: 1,
    pageSize: 10,
    hasMore: false,
    loadingMore: false,
    filterOpen: false,
    activeCategoryName: "全部分类",
    activeSortLabel: "最新发布",
    sorts: [
      { value: "newest", label: "最新发布" },
      { value: "reward", label: "报酬优先" },
      { value: "deadline", label: "时间优先" },
      { value: "distance", label: "距离优先" },
    ],
  },

  onLoad() {
    this.loadCategories();
    this.loadTasks();
  },

  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 1 });
    const categoryId = wx.getStorageSync("taskCategoryId");
    if (categoryId) {
      wx.removeStorageSync("taskCategoryId");
      this.setData({ categoryId: Number(categoryId) });
      this.loadTasks();
    }
  },

  onPullDownRefresh() {
    this.loadTasks().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadMoreTasks();
  },

  buildTaskQuery() {
    return [
      `sort=${this.data.sort}`,
      this.data.categoryId ? `categoryId=${this.data.categoryId}` : "",
      this.data.keyword ? `keyword=${encodeURIComponent(this.data.keyword)}` : "",
      `page=${this.data.page}`,
      `pageSize=${this.data.pageSize}`,
    ]
      .filter(Boolean)
      .join("&");
  },

  async loadCategories() {
    const categories = await app.request({ url: "/api/categories", auth: false });
    const activeCategory = categories.find((item) => Number(item.id) === Number(this.data.categoryId));
    this.setData({
      categories,
      activeCategoryName: activeCategory ? activeCategory.name : "全部分类",
    });
  },

  async loadTasks() {
    this.setData({ loading: true, page: 1 });
    try {
      const data = await app.request({ url: `/api/tasks?${this.buildTaskQuery()}` });
      const list = data.list.map(decorateTask);
      this.setData({
        tasks: list,
        total: data.total,
        hasMore: list.length < Number(data.total || 0),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMoreTasks() {
    this.setData({ loadingMore: true });
    try {
      this.setData({ page: this.data.page + 1 });
      const data = await app.request({ url: `/api/tasks?${this.buildTaskQuery()}` });
      const list = data.list.map(decorateTask);
      this.setData({
        tasks: this.data.tasks.concat(list),
        total: data.total,
        hasMore: this.data.tasks.length + list.length < Number(data.total || 0),
      });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value });
  },

  submitSearch() {
    this.loadTasks();
  },

  clearSearch() {
    this.setData({ keyword: "" });
    this.loadTasks();
  },

  toggleFilters() {
    this.setData({ filterOpen: !this.data.filterOpen });
  },

  selectCategory(event) {
    const categoryId = Number(event.currentTarget.dataset.id);
    const category = this.data.categories.find((item) => Number(item.id) === categoryId);
    this.setData({
      categoryId,
      activeCategoryName: category ? category.name : "全部分类",
    });
    this.loadTasks();
  },

  selectSort(event) {
    const sort = event.currentTarget.dataset.value;
    const sortItem = this.data.sorts.find((item) => item.value === sort);
    this.setData({
      sort,
      activeSortLabel: sortItem ? sortItem.label : "最新发布",
    });
    this.loadTasks();
  },

  goTask(event) {
    wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${event.currentTarget.dataset.id}` });
  },

  goPublish() {
    wx.switchTab({ url: "/pages/publish/publish" });
  },
});
