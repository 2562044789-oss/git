Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/home/home", text: "首页", icon: "/assets/icons/home.svg" },
      { pagePath: "/pages/tasks/tasks", text: "任务", icon: "/assets/icons/list.svg" },
      { pagePath: "/pages/publish/publish", text: "发布", icon: "/assets/icons/plus.svg" },
      { pagePath: "/pages/orders/orders", text: "订单", icon: "/assets/icons/clipboard.svg" },
      { pagePath: "/pages/profile/profile", text: "我的", icon: "/assets/icons/user.svg" },
    ],
  },

  methods: {
    switchTab(event) {
      const { path, index } = event.currentTarget.dataset;
      this.setData({ selected: Number(index) });
      wx.switchTab({ url: path });
    },
  },
});
