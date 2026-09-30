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

// 任务出参视图。
//
// acceptor 参数传入浏览者的接单资格（是否已实名认证并缴纳保证金）：
// 只有"任务可接 + 未认证"时才把 blocked_reason 交给前端，
// 用于把"接单"按钮替换为"去认证"引导，而不是让用户点下去才收到报错。
// 默认值取 false（fail-closed）：漏传时前端最多少显示一个按钮，
// 真正的准入判断始终在接单接口里执行。
function taskView(
  row,
  viewerId = null,
  canViewSensitive = false,
  viewerCommunity = "",
  acceptor = { canAccept: false, blockedReason: "" },
) {
  if (!row) return null;
  const canContact =
    canViewSensitive ||
    Boolean(
      viewerId &&
        (Number(viewerId) === Number(row.publisher_id) ||
          Number(viewerId) === Number(row.acceptor_id)),
    );
  const taskAcceptable =
    Number(row.status) === 0 &&
    Number(row.publisher_id) !== Number(viewerId) &&
    Boolean(viewerId);
  const acceptorReady = acceptor.canAccept !== false;
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
    can_accept: taskAcceptable && acceptorReady,
    accept_blocked_reason: taskAcceptable && !acceptorReady ? acceptor.blockedReason || "" : "",
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

// 身份证号脱敏：保留前 6 位（行政区划码）与后 4 位，中间一律打码。
//
// 身份证号属于敏感个人信息，默认不允许出现在任何接口响应中。
// 确实需要核验完整号码时，只能走单独的后台接口，并留下审计日志。
function maskIdCard(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw.length <= 10) return raw ? "*".repeat(raw.length) : "";
  return `${raw.slice(0, 6)}${"*".repeat(raw.length - 10)}${raw.slice(-4)}`;
}

// 接单员资料对外视图：刻意不包含 id_card_no 字段，
// 让"完整身份证号不出口"成为结构上的保证，而不是靠每个路由自觉。
function acceptorView(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    real_name: row.real_name,
    id_card_masked: maskIdCard(row.id_card_no),
    id_card_front: row.id_card_front,
    id_card_back: row.id_card_back,
    phone: row.phone,
    community: row.community,
    emergency_contact: row.emergency_contact,
    status: row.status,
    review_note: row.review_note,
    reviewed_at: row.reviewed_at,
    deposit_amount: row.deposit_amount,
    deposit_status: row.deposit_status,
    deposit_paid_at: row.deposit_paid_at,
    deposit_refunded_at: row.deposit_refunded_at,
    applied_at: row.applied_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  acceptorView,
  estimateDistanceKm,
  maskIdCard,
  maskPhone,
  orderView,
  publicAdminUser,
  publicUser,
  taskView,
};
