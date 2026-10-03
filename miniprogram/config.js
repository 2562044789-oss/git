// 后端地址解析：换网络、换电脑不再需要改代码。
//
// 优先级：
//   1. 手动覆盖（存储 key：backend_base_url，探测成功后自动写入，也可调试时手工 setStorage）
//   2. 正式版（envVersion === "release"）：必须是已备案的 HTTPS 域名并加入小程序后台
//      request 合法域名，占位地址上线前必须替换，否则正式版无法联网
//   3. 候选列表第一个（真机调试常用局域网 IP）
//
// app.js 启动时会按候选顺序探测 /api/config，连不通就自动切下一个并记住选择，
// 所以这里改完代码后，换 Wi-Fi / 换电脑多数情况不用再碰这个文件。
const CANDIDATE_URLS = [
  "http://172.20.10.3:3000", // 手机热点 / 局域网真机调试（改成运行后端那台电脑的 IP）
  "http://localhost:3000", // 微信开发者工具（后端跑在本机）
  "http://127.0.0.1:3000", // 同上，回环写法
];

const OVERRIDE_KEY = "backend_base_url";

const RELEASE_BASE_URL = "https://your-domain.example.com"; // TODO: 正式发布前替换

function resolveBaseUrl() {
  try {
    const override = wx.getStorageSync(OVERRIDE_KEY);
    if (override) return override;
  } catch (error) {
    // 存储不可用时退回候选列表第一个
  }
  try {
    const env = wx.getAccountInfoSync().miniProgram.envVersion;
    if (env === "release") return RELEASE_BASE_URL;
  } catch (error) {
    // 旧版基础库没有该接口时忽略，按开发环境处理
  }
  return CANDIDATE_URLS[0];
}

const BASE_URL = resolveBaseUrl();

module.exports = { BASE_URL, CANDIDATE_URLS, OVERRIDE_KEY, RELEASE_BASE_URL, resolveBaseUrl };
