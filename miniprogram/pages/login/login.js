const app = getApp();

Page({
  data: {
    nickname: "",
    agreed: false,
    loading: false,
  },

  onShow() {
    const token = wx.getStorageSync("wechat_token");
    const user = wx.getStorageSync("wechat_user");
    const manualLogout = Boolean(wx.getStorageSync("manual_logout"));
    if (token && user && !manualLogout) {
      app.globalData.token = token;
      app.globalData.user = user;
      wx.switchTab({ url: "/pages/home/home" });
    }
  },

  updateNickname(event) {
    this.setData({ nickname: event.detail.value.trim() });
  },

  toggleAgreement() {
    this.setData({ agreed: !this.data.agreed });
  },

  async authorizeLogin() {
    if (!this.data.agreed) {
      wx.showToast({ title: "请先同意用户协议", icon: "none" });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: "微信登录中", mask: true });
    try {
      const data = await app.loginWithWechat({ nickname: this.data.nickname });
      wx.hideLoading();
      wx.showToast({
        title: data.is_new_user ? "微信账号已自动注册" : "登录成功",
        icon: "success",
      });
      setTimeout(() => {
        wx.switchTab({ url: "/pages/home/home" });
      }, 500);
    } catch (error) {
      wx.hideLoading();
      wx.showModal({
        title: "微信登录失败",
        content: error.message || "请检查网络后重试",
        showCancel: false,
        confirmText: "知道了",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
});
