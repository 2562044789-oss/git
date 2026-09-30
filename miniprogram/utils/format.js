const TASK_STATUS = {
  0: { text: "待接单", className: "status-green" },
  1: { text: "已接单", className: "status-blue" },
  2: { text: "进行中", className: "status-orange" },
  3: { text: "待确认", className: "status-orange" },
  4: { text: "已完成", className: "status-gray" },
  5: { text: "已取消", className: "status-gray" },
  6: { text: "申诉中", className: "status-red" },
};

const ORDER_STATUS = {
  0: { text: "待支付", className: "status-orange" },
  1: { text: "进行中", className: "status-blue" },
  2: { text: "待确认", className: "status-orange" },
  3: { text: "已完成", className: "status-green" },
  4: { text: "已取消", className: "status-gray" },
  5: { text: "争议冻结", className: "status-red" },
};

function formatTime(value) {
  if (!value) return "待协商";
  return String(value).replace("T", " ").slice(5, 16);
}

function initials(name) {
  return String(name || "邻").slice(-2);
}

function taskStatus(status) {
  return TASK_STATUS[Number(status)] || TASK_STATUS[0];
}

function orderStatus(status) {
  return ORDER_STATUS[Number(status)] || ORDER_STATUS[0];
}

function decorateTask(task) {
  return {
    ...task,
    statusText: taskStatus(task.status).text,
    statusClass: taskStatus(task.status).className,
    timeText: formatTime(task.expect_time),
    publisherInitials: initials(task.publisher_name),
  };
}

function decorateOrder(order) {
  return {
    ...order,
    statusText: orderStatus(order.status).text,
    statusClass: orderStatus(order.status).className,
    timeText: formatTime(order.created_at),
    publisherInitials: initials(order.publisher_name),
    acceptorInitials: initials(order.acceptor_name),
  };
}

module.exports = {
  decorateOrder,
  decorateTask,
  formatTime,
  initials,
  orderStatus,
  taskStatus,
};
