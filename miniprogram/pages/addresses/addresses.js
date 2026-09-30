const app = getApp();

const emptyForm = {
  id: null,
  contactName: "",
  phone: "",
  community: "阳光社区",
  building: "",
  room: "",
  detail: "",
  addressType: 1,
  isDefault: false,
};

Page({
  data: {
    addresses: [],
    editorOpen: false,
    form: { ...emptyForm },
    saving: false,
  },

  onLoad(options) {
    this.initialAddressType = Number(options.type) === 2 ? 2 : Number(options.type) === 1 ? 1 : 0;
    this.loadAddresses().then(() => {
      if (this.initialAddressType) this.openCreate(this.initialAddressType);
    });
  },

  async loadAddresses() {
    const addresses = await app.request({ url: "/api/addresses" });
    this.setData({
      addresses: addresses.map((item) => ({
        ...item,
        typeText: Number(item.address_type) === 2 ? "送达地址" : "取件/服务地址",
      })),
    });
  },

  openCreate(addressType = 1) {
    const user = app.globalData.user || {};
    this.setData({
      editorOpen: true,
      form: {
        ...emptyForm,
        contactName: user.nickname || "",
        phone: user.phone || "",
        community: user.community || "阳光社区",
        building: user.building || "",
        room: user.room || "",
        addressType: Number(addressType) === 2 ? 2 : 1,
      },
    });
  },

  openEdit(event) {
    const address = this.data.addresses.find(
      (item) => Number(item.id) === Number(event.currentTarget.dataset.id),
    );
    this.setData({
      editorOpen: true,
      form: {
        ...address,
        addressType: Number(address.address_type) === 2 ? 2 : 1,
        isDefault: Boolean(address.is_default),
      },
    });
  },

  closeEditor() {
    this.setData({ editorOpen: false });
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: event.detail.value });
  },

  selectAddressType(event) {
    this.setData({ "form.addressType": Number(event.currentTarget.dataset.type) === 2 ? 2 : 1 });
  },

  toggleDefault() {
    this.setData({ "form.isDefault": !this.data.form.isDefault });
  },

  async saveAddress() {
    const form = this.data.form;
    if (!form.contactName || !form.phone || !form.community) {
      return wx.showToast({ title: "请填写联系人、电话和社区", icon: "none" });
    }
    this.setData({ saving: true });
    try {
      await app.request({
        url: form.id ? `/api/addresses/${form.id}` : "/api/addresses",
        method: form.id ? "PUT" : "POST",
        data: form,
      });
      wx.showToast({ title: "地址已保存", icon: "success" });
      this.setData({ editorOpen: false });
      this.loadAddresses();
    } finally {
      this.setData({ saving: false });
    }
  },

  deleteAddress(event) {
    const id = Number(event.currentTarget.dataset.id);
    wx.showModal({
      title: "删除地址",
      content: "确认删除这条常用地址吗？",
      confirmColor: "#d75f5f",
      success: async (result) => {
        if (!result.confirm) return;
        await app.request({ url: `/api/addresses/${id}`, method: "DELETE" });
        this.loadAddresses();
      },
    });
  },
});
