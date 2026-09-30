// 任务 / 订单 / 支付状态集中定义。
//
// 修复背景：修复前 tasks.status（0-6）与 orders.status（1-5）两套枚举以裸数字
// 散落在 15 处以上的 if/else 中，没有任何集中定义，是"资金账实不符""任务永久卡在
// 争议态"这类问题的结构性根源。此处统一命名，避免再出现"同一个数字在不同位置
// 含义不同"的情况。

// 任务状态：描述这一单"服务进度"
const TASK_STATUS = {
  PENDING: 0, // 待接单
  ACCEPTED: 1, // 已接单
  IN_SERVICE: 2, // 服务中
  AWAITING_CONFIRM: 3, // 接单者已提交凭证，等待发布者确认
  COMPLETED: 4, // 已完成并结算
  CANCELLED: 5, // 已取消
  DISPUTED: 6, // 争议中（投诉已受理）
};

// 订单状态：描述这一单"资金与履约"的合并状态
const ORDER_STATUS = {
  ACCEPTED: 1, // 已接单，资金托管中
  IN_SERVICE: 2, // 服务中，资金托管中
  COMPLETED: 3, // 已完成，资金已结算给接单者
  CANCELLED: 4, // 已取消 / 已退款
  DISPUTED: 5, // 争议冻结中，等待管理员裁决
};

// 支付状态：资金当前"在哪里"，是资金逻辑唯一可信的判据
const PAY_STATUS = {
  ESCROW: 1, // 托管中：发布时已从发布者余额扣除，尚未付给任何一方
  SETTLED: 2, // 已结算给接单者
  REFUNDED: 3, // 已退回发布者
};

// 投诉状态
const COMPLAINT_STATUS = {
  PENDING: 0, // 待处理
  PROCESSING: 1, // 处理中
  RESOLVED: 2, // 已裁决
  REJECTED: 3, // 已驳回
};

const TASK_STATUS_VALUES = Object.values(TASK_STATUS);
const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);

const TASK_STATUS_LABEL = {
  [TASK_STATUS.PENDING]: "待接单",
  [TASK_STATUS.ACCEPTED]: "已接单",
  [TASK_STATUS.IN_SERVICE]: "服务中",
  [TASK_STATUS.AWAITING_CONFIRM]: "待确认",
  [TASK_STATUS.COMPLETED]: "已完成",
  [TASK_STATUS.CANCELLED]: "已取消",
  [TASK_STATUS.DISPUTED]: "争议中",
};

const ORDER_STATUS_LABEL = {
  [ORDER_STATUS.ACCEPTED]: "已接单",
  [ORDER_STATUS.IN_SERVICE]: "服务中",
  [ORDER_STATUS.COMPLETED]: "已完成",
  [ORDER_STATUS.CANCELLED]: "已取消",
  [ORDER_STATUS.DISPUTED]: "争议中",
};

// 依据订单与任务的事实状态推导任务当前应处的进度。
//
// 用于投诉驳回后恢复任务状态：不再依赖 order.frozen_status 是否为 null，
// 而是从"订单是否已结算 / 是否已取消 / 接单者是否已交凭证"这些事实出发推导，
// 因此即使投诉发生在已完成订单上（不会冻结订单）也能正确恢复。
function deriveTaskStatus(order, task) {
  const orderStatus = Number(order?.status);
  const orderPayStatus = Number(order?.pay_status);
  if (orderStatus === ORDER_STATUS.COMPLETED || orderPayStatus === PAY_STATUS.SETTLED) {
    return TASK_STATUS.COMPLETED;
  }
  if (orderStatus === ORDER_STATUS.CANCELLED || orderPayStatus === PAY_STATUS.REFUNDED) {
    return TASK_STATUS.CANCELLED;
  }
  if (orderStatus === ORDER_STATUS.DISPUTED) return TASK_STATUS.DISPUTED;
  // 已有凭证提交时间 → 说明服务已完成、等待确认
  if (task?.finished_at) return TASK_STATUS.AWAITING_CONFIRM;
  if (orderStatus === ORDER_STATUS.IN_SERVICE) return TASK_STATUS.IN_SERVICE;
  if (orderStatus === ORDER_STATUS.ACCEPTED) return TASK_STATUS.ACCEPTED;
  return TASK_STATUS.PENDING;
}

module.exports = {
  COMPLAINT_STATUS,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_VALUES,
  PAY_STATUS,
  TASK_STATUS,
  TASK_STATUS_LABEL,
  TASK_STATUS_VALUES,
  deriveTaskStatus,
};
