const app = getApp();

// 接单员认证状态：0 未申请 / 1 待审核 / 2 待缴保证金 / 3 已认证 / 4 未通过 / 5 已退出
const ACCEPTOR_STATUS_TEXT = {
  0: "未认证",
  1: "审核中",
  2: "待缴保证金",
  3: "已认证",
  4: "审核未通过",
  5: "已退出",
};

const ACCEPTOR_STATUS_CLASS = {
  0: "status-gray",
  1: "status-orange",
  2: "status-orange",
  3: "status-green",
  4: "status-red",
  5: "status-gray",
};

// 接单员认证放在菜单最前面：它是"能不能接单"的前置条件，优先级高于其他功能入口
function buildMenu(acceptorSubtitle) {
  return [
    { key: "acceptor", title: "接单员认证", subtitle: acceptorSubtitle, mark: "证" },
    { key: "messages", title: "消息中心", subtitle: "订单进度与社区通知", mark: "信" },
    { key: "wallet", title: "我的钱包", subtitle: "余额与收支明细", mark: "¥" },
    { key: "addresses", title: "常用地址", subtitle: "管理服务与收件地址", mark: "址" },
    { key: "reviews", title: "我的评价", subtitle: "查看收到的邻里评价", mark: "评" },
    { key: "complaints", title: "投诉记录", subtitle: "查看投诉与处理结果", mark: "诉" },
    { key: "logout", title: "退出登录", subtitle: "重新验证微信登录状态", mark: "退" },
  ];
}

Page({
  data: {
    profile: null,
    certify: {
      certified: false,
      title: "你还不是接单员",
      subtitle: "完成实名认证并缴纳保证金后，才能接取邻居的跑腿单",
      statusText: "未认证",
      statusClass: "status-gray",
      buttonText: "申请成为接单员",
    },
    menu: buildMenu("实名认证后可接单"),
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
    const acceptor = profile.acceptor || {};
    const acceptorStatus = Number(acceptor.status || 0);
    const canAccept = Boolean(acceptor.can_accept);
    const acceptorStatusText = acceptor.status_text || ACCEPTOR_STATUS_TEXT[acceptorStatus] || "未认证";
    this.setData({
      profile: {
        ...profile,
        avatarText: String(profile.nickname || "邻").slice(-2),
        uidText: profile.uid || `SQ${100000 + Number(profile.id || 0)}`,
        balanceText: Number(profile.balance || 0).toFixed(2),
      },
      menu: buildMenu(canAccept ? "已认证 · 可接单" : acceptorStatusText),
      certify: {
        certified: canAccept,
        title: canAccept ? "接单员已认证" : "你还不是接单员",
        subtitle: canAccept
          ? `保证金 ¥${Number(acceptor.required_deposit || 0).toFixed(2)} 托管中，可正常接单`
          : acceptor.blocked_reason || "完成实名认证并缴纳保证金后，才能接取邻居的跑腿单",
        statusText: canAccept ? "可接单" : acceptorStatusText,
        statusClass: canAccept
          ? "status-green"
          : ACCEPTOR_STATUS_CLASS[acceptorStatus] || "status-gray",
        buttonText: acceptorStatus === 1 ? "查看审核进度" : "申请成为接单员",
      },
    });
  },

  goCertify() {
    wx.navigateTo({ url: "/pages/acceptor/acceptor" });
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
      acceptor: "/pages/acceptor/acceptor",
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
