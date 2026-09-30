const app = getApp();

Page({
  data: {
    balance: 0,
    records: [],
    quickAmounts: [10, 20, 50, 100],
    rechargeAmount: "10",
    walletMode: "recharge",
    processing: false,
  },

  onLoad() {
    this.loadWallet();
  },

  onShow() {
    this.loadWallet();
  },

  onPullDownRefresh() {
    this.loadWallet().finally(() => wx.stopPullDownRefresh());
  },

  switchWalletMode(event) {
    this.setData({
      walletMode: event.currentTarget.dataset.mode === "withdraw" ? "withdraw" : "recharge",
      rechargeAmount: "10",
    });
  },

  selectRechargeAmount(event) {
    this.setData({ rechargeAmount: String(event.currentTarget.dataset.amount) });
  },

  updateRechargeAmount(event) {
    this.setData({ rechargeAmount: event.detail.value });
  },

  async submitWalletAction() {
    const amount = Number(this.data.rechargeAmount);
    const isRecharge = this.data.walletMode === "recharge";
    const actionName = isRecharge ? "充值" : "提现";
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
      wx.showToast({ title: `请输入 1-1000 元的${actionName}金额`, icon: "none" });
      return;
    }
    if (!isRecharge && amount > Number(this.data.balance || 0)) {
      wx.showToast({ title: "提现金额不能超过可用余额", icon: "none" });
      return;
    }
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: `微信${actionName}`,
        content: `确认${actionName} ¥${amount.toFixed(2)} 吗？当前为本地模拟支付。`,
        confirmText: `确认${actionName}`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ processing: true });
    wx.showLoading({ title: `${actionName}处理中`, mask: true });
    try {
      const result = await app.request({
        url: isRecharge ? "/api/wallet/recharge" : "/api/wallet/withdraw",
        method: "POST",
        data: { amount },
      });
      wx.hideLoading();
      if (result.payment) {
        await new Promise((resolve, reject) => {
          wx.requestPayment({ ...result.payment, success: resolve, fail: reject });
        });
      }
      const balance = Number(result.balance || 0);
      this.setData({ balance, balanceText: balance.toFixed(2) });
      wx.showModal({
        title: `${actionName}成功`,
        content: `本次${actionName} ¥${Number(result.amount || amount).toFixed(2)}，当前余额 ¥${balance.toFixed(2)}`,
        showCancel: false,
        confirmText: "知道了",
      });
      await this.loadWallet();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || `${actionName}失败，请重试`, icon: "none" });
    } finally {
      this.setData({ processing: false });
    }
  },

  async loadWallet() {
    const wallet = await app.request({ url: "/api/wallet" });
    const typeMap = {
      1: { text: "收入", sign: "+", className: "income" },
      2: { text: "支出", sign: "-", className: "expense" },
      3: { text: "退款", sign: "+", className: "refund" },
      4: { text: "充值", sign: "+", className: "income" },
      5: { text: "提现", sign: "-", className: "expense" },
    };
    this.setData({
      balance: wallet.balance,
      balanceText: Number(wallet.balance || 0).toFixed(2),
      records: wallet.records.map((item) => ({
        ...item,
        typeText: typeMap[item.type].text,
        sign: typeMap[item.type].sign,
        className: typeMap[item.type].className,
      })),
    });
  },
});
