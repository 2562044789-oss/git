// 出参视图层：把数据库行转换成对外响应对象，集中处理敏感字段剥离。
// 从 server.js 抽出，避免同一份"是否暴露敏感信息"的判断散落在各个路由里。

const { parseJson } = require("./db");

// 用户对象对外输出：剥离 openid。
// 修复背景（原审计问题 #5）：/api/user/profile 直接返回 SELECT * 的整行，
// 把 openid 一并吐给前端，与登录接口 publicUser() 的剥离逻辑不一致。
function publicUser(user) {
  if (!user) return null;
  const { openid, ...safeUser } = user;
  return safeUser;
}

// 后台用户列表：同样剥离 openid（前端未使用该字段），保留业务需要的统计列
function publicAdminUser(user) {
  return publicUser(user);
}

function maskPhone(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 11) {
    return digits.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
  }
  if (raw.includes("*")) return raw;
  if (raw.length > 7) return raw.slice(0, 3) + "****" + raw.slice(-4);
  return raw;
}

// 基于浏览者社区与任务地址的确定性距离估算（无地图服务时的就近口径）：
// 同社区 0.2-1.4km，跨社区 1.5-2.9km；数值只用于展示与就近排序，不代表精确测距
function estimateDistanceKm(row, viewerCommunity = "") {
  const community = String(viewerCommunity || "").trim();
  const target = `${row.delivery_address || ""}${row.pickup_address || ""}`;
  if (!target) return null;
  const sameCommunity = Boolean(community) && target.includes(community);
  if (sameCommunity) {
    return Number((0.2 + (Number(row.id * 37) % 13) / 10).toFixed(1));
  }
  return Number((1.5 + (Number(row.id * 17) % 15) / 10).toFixed(1));
}

function taskView(row, viewerId = null, canViewSensitive = false, viewerCommunity = "") {
  if (!row) return null;
  const canContact =
    canViewSensitive ||
    Boolean(
      viewerId &&
        (Number(viewerId) === Number(row.publisher_id) ||
          Number(viewerId) === Number(row.acceptor_id)),
    );
  return {
    ...row,
    contact_name: canContact ? row.contact_name : row.contact_name ? "发布者" : "",
    contact_phone: canContact ? row.contact_phone : maskPhone(row.contact_phone),
    publisher_phone: canContact ? row.publisher_phone : maskPhone(row.publisher_phone),
    images: parseJson(row.images),
    completion_images: parseJson(row.completion_images),
    distance_km: estimateDistanceKm(row, viewerCommunity),
    same_community: Boolean(
      viewerCommunity &&
        `${row.delivery_address || ""}${row.pickup_address || ""}`.includes(viewerCommunity),
    ),
    can_accept:
      Number(row.status) === 0 &&
      Number(row.publisher_id) !== Number(viewerId) &&
      Boolean(viewerId),
    can_contact: canContact,
  };
}

function orderView(row) {
  if (!row) return null;
  return {
    ...row,
    task_images: parseJson(row.task_images),
    completion_images: parseJson(row.completion_images),
  };
}

module.exports = {
  estimateDistanceKm,
  maskPhone,
  orderView,
  publicAdminUser,
  publicUser,
  taskView,
};
