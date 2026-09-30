const app = getApp();

Page({
  data: {
    profile: null,
    menu: [
      { key: "messages", title: "消息中心", subtitle: "订单进度与社区通知", mark: "信" },
      { key: "wallet", title: "我的钱包", subtitle: "余额与收支明细", mark: "¥" },
      { key: "addresses", title: "常用地址", subtitle: "管理服务与收件地址", mark: "址" },
      { key: "reviews", title: "我的评价", subtitle: "查看收到的邻里评价", mark: "评" },
      { key: "complaints", title: "投诉记录", subtitle: "查看投诉与处理结果", mark: "诉" },
      { key: "logout", title: "退出登录", subtitle: "重新验证微信登录状态", mark: "退" },
    ],
  },

  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 4 });
    this.loadProfile();
  },

  onPullDownRefresh() {
    this.loadProfile().finally(() => wx.stopPullDownRefresh());
  },

  async loadProfile() {
    const profile = await app.request({ url: "/api/user/profile" });
    app.globalData.user = profile;
    this.setData({
      profile: {
        ...profile,
        avatarText: String(profile.nickname || "邻").slice(-2),
        uidText: profile.uid || `SQ${100000 + Number(profile.id || 0)}`,
        balanceText: Number(profile.balance || 0).toFixed(2),
      },
    });
  },

  openMenu(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "logout") {
      wx.showModal({
        title: "退出登录",
        content: "退出后将重新进行微信登录，是否继续？",
        success: (result) => {
          if (!result.confirm) return;
          app.logout();
        },
      });
      return;
    }
    const pageMap = {
      messages: "/pages/messages/messages",
      wallet: "/pages/wallet/wallet",
      addresses: "/pages/addresses/addresses",
      reviews: "/pages/reviews/reviews",
      complaints: "/pages/complaints/complaints",
    };
    wx.navigateTo({ url: pageMap[key] });
  },

  goPublished() {
    wx.setStorageSync("orderRole", "published");
    wx.switchTab({ url: "/pages/orders/orders" });
  },

  goAccepted() {
    wx.setStorageSync("orderRole", "accepted");
    wx.switchTab({ url: "/pages/orders/orders" });
  },

  editProfile() {
    wx.showModal({
      title: "个人资料",
      editable: true,
      placeholderText: "输入新的昵称",
      success: async (result) => {
        if (!result.confirm || !result.content.trim()) return;
        await app.request({
          url: "/api/user/profile",
          method: "PUT",
          data: { nickname: result.content.trim() },
        });
        wx.showToast({ title: "资料已更新", icon: "success" });
        this.loadProfile();
      },
    });
  },
});
