const app = document.getElementById("adminApp");
const toastEl = document.getElementById("adminToast");
const modalBackdrop = document.getElementById("adminModal");
const modalContent = document.getElementById("adminModalContent");

const state = {
  token: localStorage.getItem("sunshine_admin_token") || "",
  admin: JSON.parse(localStorage.getItem("sunshine_admin_user") || "null"),
  section: "dashboard",
  data: {},
};

const sections = [
  ["dashboard", "览", "仪表盘"],
  ["users", "用", "用户管理"],
  ["tasks", "务", "任务管理"],
  ["orders", "单", "订单管理"],
  ["categories", "类", "分类管理"],
  ["complaints", "诉", "投诉处理"],
  ["announcements", "告", "公告管理"],
  ["logs", "志", "操作日志"],
];

const statusMaps = {
  task: {
    0: ["待接单", "green"],
    1: ["已接单", "blue"],
    2: ["进行中", "orange"],
    3: ["待确认", "orange"],
    4: ["已完成", "gray"],
    5: ["已取消", "gray"],
    6: ["申诉中", "red"],
  },
  order: {
    0: ["待支付", "orange"],
    1: ["进行中", "blue"],
    2: ["待确认", "orange"],
    3: ["已完成", "green"],
    4: ["已取消", "gray"],
    5: ["争议冻结", "red"],
  },
  complaint: {
    0: ["待处理", "orange"],
    1: ["处理中", "blue"],
    2: ["已处理", "green"],
    3: ["已驳回", "gray"],
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function statusBadge(status, type) {
  const [text, color] = statusMaps[type][Number(status)] || ["未知", "gray"];
  return `<span class="status ${color}">${text}</span>`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

function openModal(content) {
  modalContent.innerHTML = content;
  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
  modalContent.innerHTML = "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (response.status === 401 && path !== "/api/admin/login") {
    logout();
    throw new Error("登录状态已失效");
  }
  if (!response.ok || payload.code !== 200) throw new Error(payload.msg || "操作失败");
  return payload.data;
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-screen">
      <section class="login-brand">
        <div class="login-brand-inner">
          <div class="brand-line"><span class="mini-mark" style="display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:#fff;color:#2e7850">阳</span>阳光社区邻里快办</div>
          <h1>邻里互助有序运行，<br>社区服务一目了然</h1>
          <p>集中处理用户、任务、订单、分类、投诉和社区公告，所有状态变更均通过服务端接口完成。</p>
        </div>
      </section>
      <section class="login-panel">
        <form class="login-form" id="adminLogin">
          <h2>管理员登录</h2>
          <p>请输入运营账号密码进入管理后台</p>
          <div class="field">
            <label for="username">管理员账号</label>
            <input class="input" id="username" name="username" value="admin" autocomplete="username" required>
          </div>
          <div class="field">
            <label for="password">登录密码</label>
            <input class="input" id="password" name="password" type="password" value="admin123" autocomplete="current-password" required>
          </div>
          <button class="primary-button wide" type="submit">进入管理后台</button>
          <div class="login-hint">演示账号：admin　演示密码：admin123</div>
        </form>
      </section>
    </main>
  `;
}

function renderShell() {
  const [sectionKey, sectionMark, sectionTitle] =
    sections.find(([key]) => key === state.section) || sections[0];
  app.innerHTML = `
    <div class="admin-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <span class="mini-mark">阳</span>
          <span>阳光社区管理后台</span>
        </div>
        <nav class="sidebar-nav">
          ${sections
            .map(
              ([key, mark, title]) => `
                <button class="nav-button ${state.section === key ? "active" : ""}" data-section="${key}">
                  <span class="nav-mark">${mark}</span>${title}
                </button>
              `,
            )
            .join("")}
        </nav>
        <div class="sidebar-user">
          <strong>${escapeHtml(state.admin?.real_name || "社区管理员")}</strong>
          <small>${escapeHtml(state.admin?.username || "admin")} · 平台运营</small>
          <button class="logout-button" id="logout">退出登录</button>
        </div>
      </aside>
      <main class="admin-main">
        <header class="topbar">
          <h1 class="topbar-title">${sectionTitle}</h1>
          <div class="topbar-meta">系统运行正常 · ${new Date().toLocaleDateString("zh-CN")}</div>
        </header>
        <section class="content" id="content">
          <div class="admin-loading" style="min-height:50vh"><p>正在加载数据</p></div>
        </section>
      </main>
    </div>
  `;
  renderSection(sectionKey);
}

async function renderSection(section) {
  state.section = section;
  const content = document.getElementById("content");
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.section === section);
  });
  try {
    if (section === "dashboard") await renderDashboard(content);
    if (section === "users") await renderUsers(content);
    if (section === "tasks") await renderTasks(content);
    if (section === "orders") await renderOrders(content);
    if (section === "categories") await renderCategories(content);
    if (section === "complaints") await renderComplaints(content);
    if (section === "announcements") await renderAnnouncements(content);
    if (section === "logs") await renderLogs(content);
  } catch (error) {
    content.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDashboard(content) {
  const data = await api("/api/admin/dashboard");
  state.data.dashboard = data;
  const maxStatus = Math.max(...data.statusDistribution.map((item) => item.total), 1);
  const statusLabels = ["待接单", "已接单", "进行中", "待确认", "已完成", "已取消", "申诉中"];
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h2>运营概览</h2>
        <p>社区互助任务与订单的实时数据</p>
      </div>
      <button class="secondary-button" id="refreshDashboard">刷新数据</button>
    </div>
    <div class="metrics-grid">
      ${[
        ["用户总数", data.metrics.userCount, "社区居民账号"],
        ["任务总数", data.metrics.taskCount, "含各状态任务"],
        ["订单总数", data.metrics.orderCount, "接单后生成"],
        ["已完成交易额", `¥${money(data.metrics.transactionAmount)}`, "平台服务费默认 0%"],
        ["待处理投诉", data.metrics.pendingComplaints, "需要管理员介入"],
      ]
        .map(
          ([label, value, note]) => `
            <article class="metric-card">
              <div class="metric-label">${label}</div>
              <div class="metric-value">${value}</div>
              <div class="metric-note">${note}</div>
            </article>
          `,
        )
        .join("")}
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">最近订单</h3>
          <button class="table-action" data-goto-section="orders">查看全部</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>订单号</th><th>任务</th><th>发布者</th><th>接单者</th><th>金额</th><th>状态</th></tr></thead>
            <tbody>
              ${data.recentOrders
                .map(
                  (order) => `
                    <tr>
                      <td>${escapeHtml(order.order_no)}</td>
                      <td>${escapeHtml(order.title)}</td>
                      <td>${escapeHtml(order.publisher_name)}</td>
                      <td>${escapeHtml(order.acceptor_name)}</td>
                      <td>¥${money(order.amount)}</td>
                      <td>${statusBadge(order.status, "order")}</td>
                    </tr>
                  `,
                )
                .join("") || '<tr><td colspan="6">暂无订单</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3 class="panel-title">任务状态分布</h3></div>
        <div class="bars">
          ${statusLabels
            .map((label, status) => {
              const count = data.statusDistribution.find((item) => Number(item.status) === status)?.total || 0;
              return `
                <div class="bar-item">
                  <span class="bar-value">${count}</span>
                  <div class="bar" style="height:${Math.max(8, (count / maxStatus) * 170)}px"></div>
                  <span class="bar-label">${label}</span>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
    </div>
  `;
}

async function renderUsers(content) {
  const keyword = state.data.userKeyword || "";
  const data = await api(`/api/admin/users?keyword=${encodeURIComponent(keyword)}`);
  const users = data.list || [];
  state.data.users = users;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>用户管理</h2><p>查询账号资料，禁用违规用户</p></div>
      <div class="toolbar">
        <input class="input" id="userKeyword" value="${escapeHtml(keyword)}" placeholder="UID、昵称、手机或社区">
        <button class="secondary-button" id="searchUsers">查询</button>
      </div>
    </div>
    <section class="panel">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>UID</th><th>昵称</th><th>社区住址</th><th>信用分</th><th>余额</th><th>发布/接单</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${users
              .map(
                (user) => `
                  <tr>
                    <td>${escapeHtml(user.uid || `SQ${100000 + Number(user.id || 0)}`)}</td>
                    <td><strong>${escapeHtml(user.nickname)}</strong><br><span class="topbar-meta">${escapeHtml(user.phone)}</span></td>
                    <td>${escapeHtml(`${user.community} ${user.building} ${user.room}`)}</td>
                    <td>${user.credit_score}</td>
                    <td>¥${money(user.balance)}</td>
                    <td>${user.published_count} / ${user.accepted_count}</td>
                    <td>${user.status ? '<span class="status green">正常</span>' : '<span class="status red">已禁用</span>'}</td>
                    <td><button class="table-action ${user.status ? "danger" : ""}" data-toggle-user="${user.id}" data-status="${user.status}">${user.status ? "禁用" : "解禁"}</button></td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function renderTasks(content) {
  const keyword = state.data.taskKeyword || "";
  const tasks = await api(`/api/admin/tasks?keyword=${encodeURIComponent(keyword)}`);
  state.data.tasks = tasks;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>任务管理</h2><p>查看任务发布与执行状态，下架违规内容</p></div>
      <div class="toolbar">
        <input class="input" id="taskKeyword" value="${escapeHtml(keyword)}" placeholder="任务标题或发布者">
        <button class="secondary-button" id="searchTasks">查询</button>
      </div>
    </div>
    <section class="panel">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>ID</th><th>任务</th><th>分类</th><th>发布者</th><th>接单者</th><th>报酬</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${tasks
              .map(
                (task) => `
                  <tr>
                    <td>${task.id}</td>
                    <td><strong>${escapeHtml(task.title)}</strong><br><span class="topbar-meta">${escapeHtml(task.pickup_address)}</span></td>
                    <td>${escapeHtml(task.category_name)}</td>
                    <td>${escapeHtml(task.publisher_name)}</td>
                    <td>${escapeHtml(task.acceptor_name || "—")}</td>
                    <td>¥${money(task.reward)}</td>
                    <td>${statusBadge(task.status, "task")}</td>
                    <td>
                      <button class="table-action" data-task-status="${task.id}" data-status="5">下架</button>
                      <button class="table-action" data-task-status="${task.id}" data-status="0">恢复</button>
                    </td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function renderOrders(content) {
  const status = state.data.orderStatus ?? "";
  const orders = await api(`/api/admin/orders${status !== "" ? `?status=${status}` : ""}`);
  state.data.orders = orders;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>订单管理</h2><p>跟踪托管、结算与异常订单</p></div>
      <div class="toolbar">
        <select class="select" id="orderStatus" style="width:160px">
          <option value="">全部状态</option>
          ${[
            [1, "进行中"],
            [2, "待确认"],
            [3, "已完成"],
            [4, "已取消"],
            [5, "退款/申诉"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${String(status) === String(value) ? "selected" : ""}>${label}</option>`,
            )
            .join("")}
        </select>
      </div>
    </div>
    <section class="panel">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>订单号</th><th>任务</th><th>分类</th><th>发布者</th><th>接单者</th><th>金额</th><th>支付</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody>
            ${orders
              .map(
                (order) => `
                  <tr>
                    <td>${escapeHtml(order.order_no)}</td>
                    <td>${escapeHtml(order.title)}</td>
                    <td>${escapeHtml(order.category_name)}</td>
                    <td>${escapeHtml(order.publisher_name)}</td>
                    <td>${escapeHtml(order.acceptor_name)}</td>
                    <td>¥${money(order.amount)}</td>
                    <td>${order.pay_status === 2 ? '<span class="status green">已结算</span>' : order.pay_status === 3 ? '<span class="status gray">已退款</span>' : '<span class="status blue">已托管</span>'}</td>
                    <td>${statusBadge(order.status, "order")}</td>
                    <td>${escapeHtml(order.created_at)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function renderCategories(content) {
  const categories = await api("/api/admin/categories");
  state.data.categories = categories;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>分类管理</h2><p>维护任务大厅的服务分类与排序</p></div>
      <button class="primary-button" data-new-category>新增分类</button>
    </div>
    <div class="category-cards">
      ${categories
        .map(
          (category) => `
            <article class="category-card">
              <div class="category-card-head">
                <span class="category-mark">${escapeHtml(category.name[0])}</span>
                ${category.status ? '<span class="status green">启用</span>' : '<span class="status gray">停用</span>'}
              </div>
              <div class="category-name" style="margin-top:12px">${escapeHtml(category.name)}</div>
              <div class="category-meta">排序 ${category.sort} · 标识 ${escapeHtml(category.icon)}</div>
              <div class="card-actions">
                <button class="table-action" data-edit-category="${category.id}">编辑</button>
                <button class="table-action ${category.status ? "danger" : ""}" data-category-status="${category.id}" data-status="${category.status}">${category.status ? "停用" : "启用"}</button>
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

async function renderComplaints(content) {
  const complaints = await api("/api/admin/complaints");
  state.data.complaints = complaints;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>投诉处理</h2><p>查看双方说明与凭证，记录处理结果</p></div>
    </div>
    <div class="category-cards" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      ${complaints
        .map(
          (complaint) => `
            <article class="complaint-card">
              <div class="complaint-head">
                <div class="complaint-title">${escapeHtml(complaint.reason)}</div>
                ${statusBadge(complaint.status, "complaint")}
              </div>
              <div class="complaint-content">
                任务：${escapeHtml(complaint.task_title)}<br>
                投诉人：${escapeHtml(complaint.complainant_name)} · 被投诉人：${escapeHtml(complaint.respondent_name)}<br><br>
                ${escapeHtml(complaint.description)}
              </div>
              <div class="card-actions">
                <button class="table-action" data-handle-complaint="${complaint.id}">${Number(complaint.status) === 0 ? "受理处理" : "查看/更新"}</button>
              </div>
            </article>
          `,
        )
        .join("") || '<div class="empty-state">暂无投诉记录</div>'}
    </div>
  `;
}

async function renderAnnouncements(content) {
  const announcements = await api("/api/admin/announcements");
  state.data.announcements = announcements;
  content.innerHTML = `
    <div class="page-head">
      <div><h2>公告管理</h2><p>发布社区公告，首页展示最新内容</p></div>
      <button class="primary-button" data-new-announcement>发布公告</button>
    </div>
    <div class="announcement-list">
      ${announcements
        .map(
          (announcement) => `
            <article class="announcement-card">
              <div class="announcement-card-head">
                <div class="announcement-title">${escapeHtml(announcement.title)}</div>
                <span class="status green">已发布</span>
              </div>
              <div class="announcement-content">${escapeHtml(announcement.content)}</div>
              <div class="topbar-meta" style="margin-top:12px">${escapeHtml(announcement.created_at)}</div>
            </article>
          `,
        )
        .join("") || '<div class="empty-state">暂无公告</div>'}
    </div>
  `;
}

const LOG_ACTION_TEXT = {
  publish_task: "发布任务",
  accept_task: "接取任务",
  start_order: "开始服务",
  finish_order: "提交完成",
  confirm_order: "确认结算",
  cancel_task: "取消任务",
  cancel_order: "取消订单",
  wallet_recharge: "钱包充值",
  wallet_withdraw: "钱包提现",
  submit_complaint: "提交投诉",
  handle_complaint: "投诉裁决",
  set_user_status: "用户启停",
  set_task_status: "任务状态变更",
  upload_image: "图片上传",
};

async function renderLogs(content) {
  const data = await api("/api/admin/logs?pageSize=100");
  const logs = data.list || [];
  content.innerHTML = `
    <div class="page-head">
      <div><h2>操作日志</h2><p>资金与关键状态操作的审计记录（最近 ${logs.length} 条 / 共 ${data.total} 条）</p></div>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr>
        </thead>
        <tbody>
          ${
            logs
              .map((log) => `
                <tr>
                  <td>${escapeHtml(log.created_at)}</td>
                  <td>${log.operator_type === 2 ? "管理员" : "用户"} ${escapeHtml(log.operator_name || log.operator_id || "")}</td>
                  <td>${escapeHtml(LOG_ACTION_TEXT[log.action] || log.action)}</td>
                  <td>${escapeHtml(log.target_type)}${log.target_id ? " #" + log.target_id : ""}</td>
                  <td>${escapeHtml(log.detail || "")}</td>
                  <td>${escapeHtml(log.ip || "")}</td>
                </tr>
              `)
              .join("") || '<tr><td colspan="6" class="empty-state">暂无操作日志</td></tr>'
          }
        </tbody>
      </table>
    </div>
  `;
}

function openCategoryEditor(category = null) {
  openModal(`
    <h2 class="modal-title">${category ? "编辑分类" : "新增分类"}</h2>
    <p class="modal-note">分类停用后不会出现在小程序任务大厅</p>
    <div class="field"><label>分类名称</label><input class="input" id="categoryName" value="${escapeHtml(category?.name || "")}"></div>
    <div class="field"><label>图标标识</label><input class="input" id="categoryIcon" value="${escapeHtml(category?.icon || "dot")}"></div>
    <div class="field"><label>主题颜色</label><input class="input" id="categoryColor" type="color" value="${escapeHtml(category?.color || "#5EAD7D")}"></div>
    <div class="field"><label>排序值</label><input class="input" id="categorySort" type="number" value="${category?.sort || 99}"></div>
    <div class="modal-actions">
      <button class="ghost-button" data-modal-close>取消</button>
      <button class="primary-button" data-save-category="${category?.id || ""}">保存</button>
    </div>
  `);
}

function complaintImages(complaint) {
  let images = [];
  try {
    images = JSON.parse(complaint.images || "[]");
  } catch {
    images = [];
  }
  if (!images.length) return "";
  return `
    <div class="field">
      <label>投诉凭证</label>
      <div class="evidence-row">
        ${images
          .map(
            (src) =>
              `<a href="${escapeHtml(src)}" target="_blank"><img class="evidence-thumb" src="${escapeHtml(src)}" alt="凭证"></a>`,
          )
          .join("")}
      </div>
    </div>`;
}

function openComplaintEditor(complaint) {
  // 订单仍有托管资金（进行中/待确认/争议冻结）时，管理员需要选择资金处置方式
  const moneyPending = [1, 2, 5].includes(Number(complaint.order_status));
  openModal(`
    <h2 class="modal-title">处理投诉</h2>
    <p class="modal-note">订单 ${escapeHtml(complaint.order_no)} · 金额 ¥${money(complaint.order_amount)}</p>
    <p class="modal-note"><strong>${escapeHtml(complaint.reason)}</strong>：${escapeHtml(complaint.description || "无补充说明")}</p>
    ${complaintImages(complaint)}
    ${
      moneyPending
        ? `
    <div class="field">
      <label>资金裁决（必选其一）</label>
      <div class="verdict-list">
        <button type="button" class="verdict-button" data-verdict="refund" data-complaint-id="${complaint.id}">裁决退款给发布者<br><small>订单取消，托管款原路退回</small></button>
        <button type="button" class="verdict-button" data-verdict="pay" data-complaint-id="${complaint.id}">裁决结算给接单者<br><small>认定服务完成，报酬到账</small></button>
        <button type="button" class="verdict-button" data-verdict="reject" data-complaint-id="${complaint.id}">驳回投诉<br><small>恢复争议冻结前状态</small></button>
      </div>
    </div>`
        : '<p class="modal-note">订单已终结，本次仅记录处理结果。</p>'
    }
    <div class="field">
      <label>处理结果说明</label>
      <textarea class="textarea" id="handleResult" placeholder="记录核验情况和处理结论，将同步通知双方">${escapeHtml(complaint.handle_result || "")}</textarea>
    </div>
    <div class="modal-actions">
      <button class="ghost-button" data-modal-close>取消</button>
      ${moneyPending ? "" : '<button class="primary-button" data-save-complaint="' + complaint.id + '">保存处理结果</button>'}
    </div>
  `);
}

function openAnnouncementEditor() {
  openModal(`
    <h2 class="modal-title">发布社区公告</h2>
    <p class="modal-note">最新公告会展示在小程序首页</p>
    <div class="field"><label>公告标题</label><input class="input" id="announcementTitle"></div>
    <div class="field"><label>公告内容</label><textarea class="textarea" id="announcementContent" maxlength="500"></textarea></div>
    <div class="modal-actions">
      <button class="ghost-button" data-modal-close>取消</button>
      <button class="primary-button" data-save-announcement>发布</button>
    </div>
  `);
}

function logout() {
  state.token = "";
  state.admin = null;
  localStorage.removeItem("sunshine_admin_token");
  localStorage.removeItem("sunshine_admin_user");
  renderLogin();
}

app.addEventListener("submit", async (event) => {
  if (event.target.id !== "adminLogin") return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password"),
      },
    });
    state.token = data.token;
    state.admin = data.admin;
    localStorage.setItem("sunshine_admin_token", data.token);
    localStorage.setItem("sunshine_admin_user", JSON.stringify(data.admin));
    state.section = "dashboard";
    renderShell();
  } catch (error) {
    showToast(error.message);
  }
});

app.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-section]");
  if (nav) {
    await renderSection(nav.dataset.section);
    return;
  }

  const goto = event.target.closest("[data-goto-section]");
  if (goto) {
    await renderSection(goto.dataset.gotoSection);
    return;
  }

  if (event.target.id === "logout") {
    logout();
    return;
  }

  if (event.target.id === "refreshDashboard") {
    await renderSection("dashboard");
    return;
  }

  if (event.target.id === "searchUsers") {
    state.data.userKeyword = document.getElementById("userKeyword").value.trim();
    await renderSection("users");
    return;
  }

  if (event.target.id === "searchTasks") {
    state.data.taskKeyword = document.getElementById("taskKeyword").value.trim();
    await renderSection("tasks");
    return;
  }

  const userToggle = event.target.closest("[data-toggle-user]");
  if (userToggle) {
    try {
      await api(`/api/admin/users/${userToggle.dataset.toggleUser}/status`, {
        method: "PUT",
        body: { status: Number(userToggle.dataset.status) ? 0 : 1 },
      });
      showToast("用户状态已更新");
      await renderSection("users");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const taskStatus = event.target.closest("[data-task-status]");
  if (taskStatus) {
    try {
      await api(`/api/admin/tasks/${taskStatus.dataset.taskStatus}/status`, {
        method: "PUT",
        body: { status: Number(taskStatus.dataset.status) },
      });
      showToast(Number(taskStatus.dataset.status) === 5 ? "任务已下架" : "任务已恢复");
      await renderSection("tasks");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const newCategory = event.target.closest("[data-new-category]");
  if (newCategory) {
    openCategoryEditor();
    return;
  }

  const editCategory = event.target.closest("[data-edit-category]");
  if (editCategory) {
    const category = state.data.categories.find(
      (item) => Number(item.id) === Number(editCategory.dataset.editCategory),
    );
    openCategoryEditor(category);
    return;
  }

  const categoryStatus = event.target.closest("[data-category-status]");
  if (categoryStatus) {
    const category = state.data.categories.find(
      (item) => Number(item.id) === Number(categoryStatus.dataset.categoryStatus),
    );
    await api(`/api/admin/categories/${category.id}`, {
      method: "PUT",
      body: { ...category, status: Number(categoryStatus.dataset.status) ? 0 : 1 },
    });
    showToast("分类状态已更新");
    await renderSection("categories");
    return;
  }

  const saveCategory = event.target.closest("[data-save-category]");
  if (saveCategory) {
    const id = saveCategory.dataset.saveCategory;
    const body = {
      name: document.getElementById("categoryName").value.trim(),
      icon: document.getElementById("categoryIcon").value.trim(),
      color: document.getElementById("categoryColor").value,
      sort: Number(document.getElementById("categorySort").value),
      status: 1,
    };
    if (!body.name) return showToast("请输入分类名称");
    try {
      await api(id ? `/api/admin/categories/${id}` : "/api/admin/categories", {
        method: id ? "PUT" : "POST",
        body,
      });
      closeModal();
      showToast("分类已保存");
      await renderSection("categories");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const handleComplaint = event.target.closest("[data-handle-complaint]");
  if (handleComplaint) {
    const complaint = state.data.complaints.find(
      (item) => Number(item.id) === Number(handleComplaint.dataset.handleComplaint),
    );
    openComplaintEditor(complaint);
    return;
  }

  const verdictBtn = event.target.closest("[data-verdict]");
  if (verdictBtn) {
    const resultText = document.getElementById("handleResult").value.trim();
    if (!resultText) {
      showToast("请先填写处理结果说明");
      return;
    }
    try {
      await api(`/api/admin/complaints/${verdictBtn.dataset.complaintId}`, {
        method: "PUT",
        body: { verdict: verdictBtn.dataset.verdict, handleResult: resultText },
      });
      closeModal();
      showToast("裁决已生效，双方将收到消息通知");
      await renderSection("complaints");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const saveComplaint = event.target.closest("[data-save-complaint]");
  if (saveComplaint) {
    try {
      await api(`/api/admin/complaints/${saveComplaint.dataset.saveComplaint}`, {
        method: "PUT",
        body: {
          status: 2,
          handleResult: document.getElementById("handleResult").value.trim(),
        },
      });
      closeModal();
      showToast("投诉处理结果已保存");
      await renderSection("complaints");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const newAnnouncement = event.target.closest("[data-new-announcement]");
  if (newAnnouncement) {
    openAnnouncementEditor();
    return;
  }

  const saveAnnouncement = event.target.closest("[data-save-announcement]");
  if (saveAnnouncement) {
    const title = document.getElementById("announcementTitle").value.trim();
    const content = document.getElementById("announcementContent").value.trim();
    if (!title || !content) return showToast("请填写公告标题和内容");
    try {
      await api("/api/admin/announcements", {
        method: "POST",
        body: { title, content },
      });
      closeModal();
      showToast("公告已发布");
      await renderSection("announcements");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  if (event.target.closest("[data-modal-close]")) closeModal();
});

document.getElementById("adminApp").addEventListener("change", async (event) => {
  if (event.target.id === "orderStatus") {
    state.data.orderStatus = event.target.value;
    await renderSection("orders");
  }
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop || event.target.closest("[data-modal-close]")) closeModal();
});

modalBackdrop.addEventListener("click", async (event) => {
  const saveCategory = event.target.closest("[data-save-category]");
  if (saveCategory) {
    const id = saveCategory.dataset.saveCategory;
    const body = {
      name: document.getElementById("categoryName").value.trim(),
      icon: document.getElementById("categoryIcon").value.trim(),
      color: document.getElementById("categoryColor").value,
      sort: Number(document.getElementById("categorySort").value),
      status: 1,
    };
    if (!body.name) return showToast("请输入分类名称");
    try {
      await api(id ? `/api/admin/categories/${id}` : "/api/admin/categories", {
        method: id ? "PUT" : "POST",
        body,
      });
      closeModal();
      showToast("分类已保存");
      await renderSection("categories");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const verdictBtn = event.target.closest("[data-verdict]");
  if (verdictBtn) {
    const resultText = document.getElementById("handleResult").value.trim();
    if (!resultText) {
      showToast("请先填写处理结果说明");
      return;
    }
    try {
      await api(`/api/admin/complaints/${verdictBtn.dataset.complaintId}`, {
        method: "PUT",
        body: { verdict: verdictBtn.dataset.verdict, handleResult: resultText },
      });
      closeModal();
      showToast("裁决已生效，双方将收到消息通知");
      await renderSection("complaints");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const saveComplaint = event.target.closest("[data-save-complaint]");
  if (saveComplaint) {
    try {
      await api(`/api/admin/complaints/${saveComplaint.dataset.saveComplaint}`, {
        method: "PUT",
        body: {
          status: 2,
          handleResult: document.getElementById("handleResult").value.trim(),
        },
      });
      closeModal();
      showToast("投诉处理结果已保存");
      await renderSection("complaints");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const saveAnnouncement = event.target.closest("[data-save-announcement]");
  if (saveAnnouncement) {
    const title = document.getElementById("announcementTitle").value.trim();
    const content = document.getElementById("announcementContent").value.trim();
    if (!title || !content) return showToast("请填写公告标题和内容");
    try {
      await api("/api/admin/announcements", {
        method: "POST",
        body: { title, content },
      });
      closeModal();
      showToast("公告已发布");
      await renderSection("announcements");
    } catch (error) {
      showToast(error.message);
    }
  }
});

async function init() {
  if (!state.token || !state.admin) {
    renderLogin();
    return;
  }
  try {
    state.admin = await refreshAdmin();
  } catch {
    logout();
    return;
  }
  renderShell();
}

async function refreshAdmin() {
  // A lightweight authenticated request verifies the saved token.
  await api("/api/admin/dashboard");
  return state.admin;
}

init();
