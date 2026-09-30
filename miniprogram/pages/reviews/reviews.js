const app = getApp();

Page({
  data: {
    orderId: null,
    order: null,
    reviews: [],
    formOpen: false,
    submitting: false,
    rating: 5,
    tags: [
      { name: "准时高效", active: false },
      { name: "沟通友好", active: false },
      { name: "认真负责", active: false },
      { name: "物品完好", active: false },
    ],
    selectedTags: [],
    content: "",
  },

  onLoad(options) {
    if (options.orderId) {
      this.setData({ orderId: Number(options.orderId), formOpen: true });
      this.loadOrder();
    } else {
      this.loadReviews();
    }
  },

  async loadOrder() {
    const order = await app.request({ url: `/api/orders/${this.data.orderId}` });
    this.setData({ order });
  },

  async loadReviews() {
    const reviews = await app.request({ url: "/api/reviews" });
    this.setData({ reviews });
  },

  selectRating(event) {
    this.setData({ rating: Number(event.currentTarget.dataset.rating) });
  },

  toggleTag(event) {
    const tag = event.currentTarget.dataset.tag;
    const tags = this.data.tags.map((item) =>
      item.name === tag ? { ...item, active: !item.active } : item,
    );
    this.setData({
      tags,
      selectedTags: tags.filter((item) => item.active).map((item) => item.name),
    });
  },

  updateContent(event) {
    this.setData({ content: event.detail.value });
  },

  async submit() {
    this.setData({ submitting: true });
    try {
      await app.request({
        url: `/api/orders/${this.data.orderId}/review`,
        method: "POST",
        data: {
          rating: this.data.rating,
          tags: this.data.selectedTags,
          content: this.data.content,
        },
      });
      wx.showToast({ title: "评价已提交", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } finally {
      this.setData({ submitting: false });
    }
  },

  goOrder(event) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${event.currentTarget.dataset.id}` });
  },
});
