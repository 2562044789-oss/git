const app = getApp();

// 接单员认证状态：0 未申请 / 1 待审核 / 2 待缴保证金 / 3 已认证 / 4 未通过 / 5 已退出
const STATUS_TEXT = {
  0: "未认证",
  1: "审核中",
  2: "待缴保证金",
  3: "已认证",
  4: "审核未通过",
  5: "已退出",
};

const STATUS_CLASS = {
  0: "status-gray",
  1: "status-orange",
  2: "status-orange",
  3: "status-green",
  4: "status-red",
  5: "status-gray",
};

// 后端保存的是相对路径（如 /uploads/xxx.jpg），
// 微信 image 组件需要完整地址，这里统一补全 baseUrl。
function toAbsolute(url) {
  const value = String(url || "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${app.globalData.baseUrl}${value}`;
}

Page({
  data: {
    loading: true,
    status: 0,
    statusText: "未认证",
    statusClass: "status-gray",
    canApply: true,
    requiredDepositText: "0.00",
    depositAmountText: "0.00",
    balanceText: "0.00",
    profile: null,
    // 表单字段
    realName: "",
    idCardNo: "",
    phone: "",
    emergencyContact: "",
    idCardFront: "",
    idCardBack: "",
    idCardFrontUrl: "",
    idCardBackUrl: "",
    submitting: false,
    paying: false,
    quitting: false,
  },

  onLoad() {
    this.loadProfile();
  },

  onShow() {
    this.loadProfile();
  },

  onPullDownRefresh() {
    this.loadProfile().finally(() => wx.stopPullDownRefresh());
  },

  async loadProfile() {
    this.setData({ loading: true });
    try {
      // 余额可能被钱包页改动过，这里重新拉一次资料，避免展示过期的可用余额
      const [info, user] = await Promise.all([
        app.request({ url: "/api/acceptor/profile" }),
        app.request({ url: "/api/user/profile" }),
      ]);
      app.globalData.user = user;
      const status = Number(info.status || 0);
      const profile = info.profile || null;
      this.setData({
        status,
        statusText: info.status_text || STATUS_TEXT[status] || "未认证",
        statusClass: STATUS_CLASS[status] || "status-gray",
        // 只有未申请 / 未通过 / 已退出 三种状态可以（重新）提交资料
        canApply: [0, 4, 5].includes(status),
        requiredDepositText: Number(info.required_deposit || 0).toFixed(2),
        depositAmountText: Number(profile ? profile.deposit_amount : 0).toFixed(2),
        balanceText: Number(user.balance || 0).toFixed(2),
        profile,
        realName: profile ? profile.real_name : "",
        phone: profile ? profile.phone : user.phone || "",
        emergencyContact: profile ? profile.emergency_contact : "",
        idCardFront: profile ? profile.id_card_front : "",
        idCardBack: profile ? profile.id_card_back : "",
        idCardFrontUrl: toAbsolute(profile ? profile.id_card_front : ""),
        idCardBackUrl: toAbsolute(profile ? profile.id_card_back : ""),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onFormInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  choosePhoto(event) {
    const side = event.currentTarget.dataset.side === "back" ? "back" : "front";
    const handle = (localPath) => {
      wx.showLoading({ title: "上传中", mask: true });
      app
        .uploadImage(localPath)
        .then((fullUrl) => {
          // 提交给后端用相对路径，页面展示用完整地址
          const relative = fullUrl.startsWith(app.globalData.baseUrl)
            ? fullUrl.slice(app.globalData.baseUrl.length)
            : fullUrl;
          this.setData(
            side === "back"
              ? { idCardBack: relative, idCardBackUrl: fullUrl }
              : { idCardFront: relative, idCardFrontUrl: fullUrl },
          );
          wx.hideLoading();
          wx.showToast({ title: "照片已更新", icon: "success" });
        })
        .catch((error) => {
          wx.hideLoading();
          wx.showToast({ title: error.message || "图片上传失败", icon: "none" });
        });
    };

    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sizeType: ["compressed"],
        success: (result) => {
          const file = (result.tempFiles || [])[0];
          if (file) handle(file.tempFilePath);
        },
      });
      return;
    }
    wx.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      success: (result) => {
        const path = (result.tempFilePaths || [])[0];
        if (path) handle(path);
      },
    });
  },

  async submitApply() {
    if (this.data.submitting) return;
    const realName = String(this.data.realName || "").trim();
    const idCardNo = String(this.data.idCardNo || "").trim().toUpperCase();
    const phone = String(this.data.phone || "").trim();
    const emergencyContact = String(this.data.emergencyContact || "").trim();
    if (!realName || !idCardNo || !phone) {
      wx.showToast({ title: "请填写真实姓名、身份证号与手机号", icon: "none" });
      return;
    }
    if (!this.data.idCardFront || !this.data.idCardBack) {
      wx.showToast({ title: "请上传身份证正面与反面照片", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      await app.request({
        url: "/api/acceptor/apply",
        method: "POST",
        data: {
          realName,
          idCardNo,
          phone,
          emergencyContact,
          idCardFront: this.data.idCardFront,
          idCardBack: this.data.idCardBack,
        },
      });
      wx.showToast({ title: "资料已提交，等待审核", icon: "success" });
      await this.refreshUser();
      await this.loadProfile();
    } catch (error) {
      // app.request 已弹出后端返回的错误提示，这里只兜底网络异常
    } finally {
      this.setData({ submitting: false });
    }
  },

  async payDeposit() {
    if (this.data.paying) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "缴纳接单保证金",
        content: `将从钱包余额扣除 ¥${this.data.requiredDepositText} 作为接单保证金，退出接单员时原路退回。确认缴纳吗？`,
        confirmText: "确认缴纳",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ paying: true });
    try {
      await app.request({ url: "/api/acceptor/deposit", method: "POST" });
      wx.showToast({ title: "保证金已缴纳", icon: "success" });
      await this.refreshUser();
      await this.loadProfile();
    } catch (error) {
      // 余额不足等业务错误由 app.request 统一提示
    } finally {
      this.setData({ paying: false });
    }
  },

  async quitAcceptor() {
    if (this.data.quitting) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "退出接单员",
        content: `退出后保证金 ¥${this.data.depositAmountText} 将退回钱包余额，同时会失去接单资格。确认退出吗？`,
        confirmText: "确认退出",
        confirmColor: "#d75f5f",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ quitting: true });
    try {
      await app.request({ url: "/api/acceptor/quit", method: "POST" });
      wx.showToast({ title: "已退出，保证金已退回", icon: "success" });
      await this.refreshUser();
      await this.loadProfile();
    } catch (error) {
      // 有进行中订单时后端会拒绝退出并提示原因
    } finally {
      this.setData({ quitting: false });
    }
  },

  // 认证/保证金会改变余额与接单资格，刷新全局用户对象保证其他页面读到最新值
  async refreshUser() {
    try {
      const profile = await app.request({ url: "/api/user/profile" });
      app.globalData.user = profile;
    } catch (error) {
      // 刷新失败不阻塞主流程
    }
  },
});
