const { BASE_URL } = require("./config");

const STORAGE_KEYS = {
  token: "wechat_token",
  user: "wechat_user",
  device: "wechat_device_id",
  manualLogout: "manual_logout",
};

App({
  globalData: {
    baseUrl: BASE_URL,
    token: "",
    user: null,
    unread: 0,
  },

  onLaunch() {
    wx.removeStorageSync("token");
    wx.removeStorageSync("user");
    const token = wx.getStorageSync(STORAGE_KEYS.token);
    const user = wx.getStorageSync(STORAGE_KEYS.user);
    const manualLogout = Boolean(wx.getStorageSync(STORAGE_KEYS.manualLogout));
    if (token && user && !manualLogout) {
      this.globalData.token = token;
      this.globalData.user = user;
    }
  },

  getOrCreateDeviceId() {
    let deviceId = wx.getStorageSync(STORAGE_KEYS.device);
    if (!deviceId) {
      deviceId = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      wx.setStorageSync(STORAGE_KEYS.device, deviceId);
    }
    return deviceId;
  },

  getUser() {
    return this.globalData.user || wx.getStorageSync(STORAGE_KEYS.user) || null;
  },

  ensureLogin() {
    if (this.globalData.token && this.globalData.user) {
      return Promise.resolve(this.globalData.user);
    }
    const current = getCurrentPages().slice(-1)[0];
    if (!current || current.route !== "pages/login/login") {
      wx.reLaunch({ url: "/pages/login/login" });
    }
    const error = new Error("请先完成微信授权登录");
    error.code = "NOT_LOGGED_IN";
    return Promise.reject(error);
  },

  getWechatCode() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (result) => {
          if (result.code) resolve(result.code);
          else reject(new Error("微信登录凭证获取失败"));
        },
        fail: () => reject(new Error("微信登录失败，请重试")),
      });
    });
  },

  async loginWithWechat(profile = {}) {
    const code = await this.getWechatCode();
    const data = await this.request({
      url: "/api/auth/login",
      method: "POST",
      auth: false,
      data: {
        code,
        deviceId: this.getOrCreateDeviceId(),
        nickname: profile.nickname || "",
        community: profile.community || "阳光社区",
      },
    });
    this.globalData.token = data.token;
    this.globalData.user = data.user;
    wx.setStorageSync(STORAGE_KEYS.token, data.token);
    wx.setStorageSync(STORAGE_KEYS.user, data.user);
    wx.removeStorageSync(STORAGE_KEYS.manualLogout);
    return data;
  },

  clearLoginState() {
    this.globalData.token = "";
    this.globalData.user = null;
    this.globalData.unread = 0;
    wx.removeStorageSync(STORAGE_KEYS.token);
    wx.removeStorageSync(STORAGE_KEYS.user);
  },

  logout() {
    this.clearLoginState();
    wx.setStorageSync(STORAGE_KEYS.manualLogout, true);
    wx.reLaunch({ url: "/pages/login/login" });
  },

  request(options) {
    const { url, method = "GET", data, auth = true, silent = false } = options;
    return new Promise((resolve, reject) => {
      const send = () => {
        wx.request({
          url: `${this.globalData.baseUrl}${url}`,
          method,
          data,
          timeout: 10000,
          header: {
            "Content-Type": "application/json",
            ...(auth && this.globalData.token
              ? { Authorization: `Bearer ${this.globalData.token}` }
              : {}),
          },
          success: (response) => {
            const payload = response.data || {};
            if (response.statusCode >= 200 && response.statusCode < 300 && payload.code === 200) {
              resolve(payload.data);
              return;
            }
            if (response.statusCode === 401 && auth) {
              this.clearLoginState();
              wx.setStorageSync(STORAGE_KEYS.manualLogout, true);
              wx.reLaunch({ url: "/pages/login/login" });
              reject(new Error("登录状态已失效，请重新授权"));
              return;
            }
            if (!silent) {
              wx.showToast({ title: payload.msg || "请求失败", icon: "none" });
            }
            const error = new Error(payload.msg || "请求失败");
            // 附带 HTTP 状态码：页面可据此区分"接单被认证门槛拦截(403)"等场景
            error.statusCode = response.statusCode;
            error.bizCode = payload.code;
            reject(error);
          },
          fail: (error) => {
            const reason = String(error && error.errMsg ? error.errMsg : "");
            const message = reason.includes("timeout")
              ? `连接后端超时，请检查手机和电脑网络：${this.globalData.baseUrl}`
              : `无法连接后端，请确认服务已启动：${this.globalData.baseUrl}`;
            if (!silent) {
              wx.showToast({ title: message, icon: "none", duration: 3000 });
            }
            reject(new Error(message));
          },
        });
      };

      if (auth) {
        this.ensureLogin().then(send).catch(reject);
      } else {
        send();
      }
    });
  },

  // 本地图片先压缩，再以 base64 上传到后端，返回可公开访问的图片 URL
  // （不能直接把 wxfile:// 临时路径提交给后端，其他用户无法访问）
  uploadImage(localPath) {
    return new Promise((resolve, reject) => {
      wx.compressImage({
        src: localPath,
        quality: 60,
        compressedWidth: 1280,
        success: (compressed) => {
          const filePath = compressed.tempFilePath || localPath;
          wx.getFileSystemManager().readFile({
            filePath,
            encoding: "base64",
            success: (file) => {
              const ext = /\.png$/i.test(localPath) ? "png" : /\.webp$/i.test(localPath) ? "webp" : "jpeg";
              this.request({
                url: "/api/upload",
                method: "POST",
                data: { dataUrl: `data:image/${ext};base64,${file.data}` },
              })
                .then((result) => resolve(`${this.globalData.baseUrl}${result.url}`))
                .catch(reject);
            },
            fail: () => reject(new Error("图片读取失败，请重试")),
          });
        },
        fail: () => reject(new Error("图片压缩失败，请重试")),
      });
    });
  },
});
