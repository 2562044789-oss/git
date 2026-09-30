const app = getApp();

Page({
  data: {
    categories: [],
    addresses: [],
    pickerAddresses: [],
    addressPickerOpen: false,
    addressTarget: "delivery",
    deliveryRequired: true,
    serviceOnly: false,
    submitting: false,
    form: {
      categoryId: 0,
      title: "",
      description: "",
      pickupAddress: "",
      deliveryAddress: "",
      pickupAddressId: null,
      deliveryAddressId: null,
      contactName: "",
      contactPhone: "",
      expectTime: "",
      reward: "",
      images: [],
    },
    quickRewards: [5, 8, 12, 20],
    minDate: "",
  },

  onLoad() {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    const minDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
    this.setData({ minDate });
    this.loadBaseData();
  },

  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    if (this.data.categories.length) this.loadAddresses();
  },

  async loadBaseData() {
    const [categories, profile, addresses] = await Promise.all([
      app.request({ url: "/api/categories", auth: false }),
      app.request({ url: "/api/user/profile" }),
      app.request({ url: "/api/addresses" }),
    ]);
    this.setData({
      categories: categories.map((item) => ({
        ...item,
        addressMode: Number(item.address_mode) === 2 ? 2 : 1,
      })),
      addresses: addresses.map((item) => ({
        ...item,
        fullAddress: [item.community, item.building, item.room, item.detail].filter(Boolean).join(" "),
        addressType: Number(item.address_type) === 2 ? 2 : 1,
      })),
      "form.contactName": profile.nickname,
      "form.contactPhone": profile.phone,
    });
  },

  async loadAddresses() {
    const addresses = await app.request({ url: "/api/addresses" });
    this.setData({
      addresses: addresses.map((item) => ({
        ...item,
        fullAddress: [item.community, item.building, item.room, item.detail].filter(Boolean).join(" "),
        addressType: Number(item.address_type) === 2 ? 2 : 1,
      })),
    });
  },

  openAddressPicker(event) {
    const addressTarget = event.currentTarget.dataset.target;
    const addressType = addressTarget === "pickup" ? 1 : 2;
    this.setData({
      addressTarget,
      pickerAddresses: this.data.addresses.filter((item) => item.addressType === addressType),
      addressPickerOpen: true,
    });
  },

  closeAddressPicker() {
    this.setData({ addressPickerOpen: false });
  },

  selectAddress(event) {
    const address = this.data.pickerAddresses.find(
      (item) => Number(item.id) === Number(event.currentTarget.dataset.id),
    );
    if (!address) return;
    const isPickup = this.data.addressTarget === "pickup";
    const otherId = isPickup ? this.data.form.deliveryAddressId : this.data.form.pickupAddressId;
    if (otherId && Number(otherId) === Number(address.id)) {
      wx.showToast({ title: "取件地址和送达地址不能相同", icon: "none" });
      return;
    }
    const field = isPickup ? "pickupAddress" : "deliveryAddress";
    const idField = isPickup ? "pickupAddressId" : "deliveryAddressId";
    this.setData({
      [`form.${field}`]: address.fullAddress,
      [`form.${idField}`]: Number(address.id),
      "form.contactName": address.contact_name,
      "form.contactPhone": address.phone,
      addressPickerOpen: false,
    });
  },

  goAddressManage() {
    const addressType = this.data.addressTarget === "pickup" ? 1 : 2;
    this.setData({ addressPickerOpen: false });
    wx.navigateTo({ url: `/pages/addresses/addresses?type=${addressType}` });
  },

  selectCategory(event) {
    const categoryId = Number(event.currentTarget.dataset.id);
    const category = this.data.categories.find((item) => Number(item.id) === categoryId);
    const serviceOnly = Number(category && category.addressMode) === 2;
    const patch = {
      "form.categoryId": categoryId,
      serviceOnly,
      deliveryRequired: !serviceOnly,
    };
    if (serviceOnly) {
      patch["form.deliveryAddress"] = "";
      patch["form.deliveryAddressId"] = null;
    }
    this.setData(patch);
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    const patch = { [`form.${field}`]: event.detail.value };
    if (field === "pickupAddress") patch["form.pickupAddressId"] = null;
    if (field === "deliveryAddress") patch["form.deliveryAddressId"] = null;
    this.setData(patch);
  },

  selectReward(event) {
    this.setData({ "form.reward": String(event.currentTarget.dataset.value) });
  },

  selectTime(event) {
    this.setData({ "form.expectTime": `${event.detail.value} 18:00:00` });
  },

  async chooseImages() {
    const remain = 3 - this.data.form.images.length;
    if (remain <= 0) {
      wx.showToast({ title: "最多上传 3 张图片", icon: "none" });
      return;
    }
    try {
      const result = await wx.chooseMedia({
        count: remain,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
      });
      wx.showLoading({ title: "图片上传中", mask: true });
      const uploaded = [];
      for (const file of result.tempFiles) {
        const url = await app.uploadImage(file.tempFilePath);
        uploaded.push(url);
      }
      this.setData({ "form.images": this.data.form.images.concat(uploaded) });
      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      if (error && error.errMsg && error.errMsg.includes("cancel")) return;
      wx.showToast({ title: error.message || "图片上传失败", icon: "none" });
    }
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const images = this.data.form.images.filter((_, itemIndex) => itemIndex !== index);
    this.setData({ "form.images": images });
  },

  async submit() {
    const form = this.data.form;
    if (!form.categoryId) return wx.showToast({ title: "请选择服务分类", icon: "none" });
    if (form.title.trim().length < 4) return wx.showToast({ title: "标题至少 4 个字", icon: "none" });
    if (!form.pickupAddress.trim()) return wx.showToast({ title: "请填写服务地址", icon: "none" });
    if (this.data.deliveryRequired && !form.deliveryAddress.trim()) return wx.showToast({ title: "请填写送达地址", icon: "none" });
    if (form.pickupAddressId && form.deliveryAddressId && Number(form.pickupAddressId) === Number(form.deliveryAddressId)) {
      return wx.showToast({ title: "取件地址和送达地址不能相同", icon: "none" });
    }
    if (!Number(form.reward)) return wx.showToast({ title: "请设置报酬金额", icon: "none" });

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "确认发布",
        content: `将从余额托管 ¥${Number(form.reward).toFixed(2)}，确认发布吗？`,
        confirmText: "确认托管",
        success: (result) => resolve(result.confirm),
      });
    });
    if (!confirmed) return;

    this.setData({ submitting: true });
    try {
      await app.request({
        url: "/api/tasks",
        method: "POST",
        data: {
          ...form,
          deliveryAddress: this.data.deliveryRequired ? form.deliveryAddress : form.pickupAddress,
          deliveryAddressId: this.data.deliveryRequired ? form.deliveryAddressId : null,
          categoryId: Number(form.categoryId),
          reward: Number(form.reward),
          contactName: form.contactName || app.globalData.user?.nickname,
          contactPhone: form.contactPhone || app.globalData.user?.phone,
        },
      });
      wx.showToast({ title: "发布成功", icon: "success" });
      this.setData({
        form: {
          categoryId: 0,
          title: "",
          description: "",
          pickupAddress: "",
          deliveryAddress: "",
          pickupAddressId: null,
          deliveryAddressId: null,
          contactName: app.globalData.user?.nickname || "",
          contactPhone: app.globalData.user?.phone || "",
          expectTime: "",
          reward: "",
          images: [],
        },
        deliveryRequired: true,
        serviceOnly: false,
      });
      wx.setStorageSync("orderRole", "published");
      setTimeout(() => wx.switchTab({ url: "/pages/orders/orders" }), 600);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
