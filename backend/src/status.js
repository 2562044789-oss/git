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

// 接单员认证状态。
// 接单是"平台代为交付服务"的行为，因此比发布任务要求更高：
// 必须完成实名认证（身份证 + 手机号）并缴纳保证金后才具备接单资格。
// NONE 不落库，仅用于对外表达"该用户从未提交过申请"。
const ACCEPTOR_STATUS = {
  NONE: 0, // 未申请
  REVIEWING: 1, // 已提交资料，等待管理员审核
  APPROVED: 2, // 审核通过，待缴纳保证金
  ACTIVE: 3, // 已认证，具备接单资格
  REJECTED: 4, // 审核未通过
  QUIT: 5, // 已退出接单员（保证金已退还）
};

// 保证金状态：与 PAY_STATUS 同样的思路——它描述"钱在哪里"，
// 是判断保证金是否需要退还的唯一可信依据。
const DEPOSIT_STATUS = {
  UNPAID: 0, // 未缴纳
  HELD: 1, // 已缴纳并托管在平台
  REFUNDED: 2, // 已退还本人
};

// 钱包流水类型。保证金相关的两笔单独编号，
// 避免与"发布托管 / 取消退款"混为一谈导致对账困难。
const WALLET_TYPE = {
  SETTLEMENT: 1, // 订单结算收入
  ESCROW: 2, // 发布任务托管扣款 / 裁决扣回
  REFUND: 3, // 订单取消或裁决退款
  RECHARGE: 4, // 充值
  WITHDRAW: 5, // 提现
  DEPOSIT: 6, // 接单员保证金缴纳
  DEPOSIT_REFUND: 7, // 接单员保证金退还
};

const TASK_STATUS_VALUES = Object.values(TASK_STATUS);
const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);
const ACCEPTOR_STATUS_VALUES = Object.values(ACCEPTOR_STATUS);

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

const ACCEPTOR_STATUS_LABEL = {
  [ACCEPTOR_STATUS.NONE]: "未认证",
  [ACCEPTOR_STATUS.REVIEWING]: "审核中",
  [ACCEPTOR_STATUS.APPROVED]: "待缴保证金",
  [ACCEPTOR_STATUS.ACTIVE]: "已认证",
  [ACCEPTOR_STATUS.REJECTED]: "审核未通过",
  [ACCEPTOR_STATUS.QUIT]: "已退出",
};

const DEPOSIT_STATUS_LABEL = {
  [DEPOSIT_STATUS.UNPAID]: "未缴纳",
  [DEPOSIT_STATUS.HELD]: "已缴纳",
  [DEPOSIT_STATUS.REFUNDED]: "已退还",
};

// 是否具备接单资格——接单接口与前端按钮唯一应使用的判断。
function isAcceptorActive(profile) {
  return (
    Boolean(profile) &&
    Number(profile.status) === ACCEPTOR_STATUS.ACTIVE &&
    Number(profile.deposit_status) === DEPOSIT_STATUS.HELD
  );
}

// 未具备资格时，告诉用户"还差哪一步"，而不是笼统地说"无权限"。
function describeAcceptorBlocker(profile) {
  if (!profile) return "你还没有接单员认证，请先提交实名认证申请";
  switch (Number(profile.status)) {
    case ACCEPTOR_STATUS.REVIEWING:
      return "实名认证正在审核中，通过后缴纳保证金即可接单";
    case ACCEPTOR_STATUS.APPROVED:
      return "实名认证已通过，缴纳保证金后即可开始接单";
    case ACCEPTOR_STATUS.REJECTED:
      return "实名认证未通过，请修改资料后重新提交";
    case ACCEPTOR_STATUS.QUIT:
      return "你已退出接单员，重新提交认证并通过审核后可再次接单";
    default:
      return "你还没有接单员认证，请先提交实名认证申请";
  }
}

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
  ACCEPTOR_STATUS,
  ACCEPTOR_STATUS_LABEL,
  ACCEPTOR_STATUS_VALUES,
  COMPLAINT_STATUS,
  DEPOSIT_STATUS,
  DEPOSIT_STATUS_LABEL,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_VALUES,
  PAY_STATUS,
  TASK_STATUS,
  TASK_STATUS_LABEL,
  TASK_STATUS_VALUES,
  WALLET_TYPE,
  deriveTaskStatus,
  describeAcceptorBlocker,
  isAcceptorActive,
};
