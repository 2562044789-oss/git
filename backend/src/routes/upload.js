// 上传域：图片上传（base64 → 落盘 public/uploads）。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { enforceRateLimit, HttpError, ok, parseBody, requireValue } = require("../http");

module.exports = async function handleUpload(req, res, url, ctx) {
  const { method, pathname, identity, logOperation, PUBLIC_DIR, MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES } = ctx;

  // 图片上传：接收 base64 dataURL，落盘到 public/uploads 并返回可访问 URL；
  // 生产环境可把本函数内部替换为对象存储（OSS/COS）上传，接口契约保持不变
  if (method === "POST" && pathname === "/api/upload") {
    enforceRateLimit(req, "upload", 60);
    const body = await parseBody(req);
    const dataUrl = String(body.dataUrl || "");
    const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
    requireValue(match, "仅支持 jpg、png、webp 格式图片");
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    let buffer;
    try {
      buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    } catch {
      throw new HttpError(400, "图片数据无效");
    }
    requireValue(buffer.length > 0, "图片数据无效");
    requireValue(buffer.length <= 5 * 1024 * 1024, "图片大小不能超过 5MB");
    const uploadDir = path.join(PUBLIC_DIR, "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    // 上传总量配额（原审计问题 #35）：原先只限"单文件 5MB + 60 次/分"，
    // 持续调用可以打满磁盘、拖垮整个服务。这里加一道目录总量兜底。
    const existing = fs.readdirSync(uploadDir);
    requireValue(existing.length < MAX_UPLOAD_FILES, "上传文件数量已达上限，请联系管理员清理");
    const usedBytes = existing.reduce((sum, name) => {
      try {
        return sum + fs.statSync(path.join(uploadDir, name)).size;
      } catch {
        return sum;
      }
    }, 0);
    requireValue(usedBytes + buffer.length <= MAX_UPLOAD_BYTES, "上传空间已满，请联系管理员清理");
    const fileName = `u${Date.now()}${crypto.randomInt(1000, 9999)}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
    logOperation(identity, "upload_image", "file", null, `${fileName}, ${buffer.length}B`, req);
    ok(res, { url: `/uploads/${fileName}` }, "上传成功");
    return true;
  }

  return false;
};
