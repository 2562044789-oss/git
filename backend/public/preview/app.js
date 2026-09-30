const state = {
  token: localStorage.getItem("sunshine_preview_token") || "",
  user: null,
  config: null,
  categories: [],
  tasks: [],
  orders: [],
  view: "home",
  taskCategoryId: 0,
  taskSort: "newest",
  taskKeyword: "",
  orderRole: "published",
  orderStatus: "",
  loading: false,
};

const app = document.getElementById("app");
const tabBar = document.getElementById("tabBar");
const toastEl = document.getElementById("toast");
const modalBackdrop = document.getElementById("modalBackdrop");
const modal = document.getElementById("modal");

const icons = {
  home: '<path d="m3 10.5 9-7.5 9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  clipboard: '<rect width="16" height="18" x="4" y="4" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

function icon(name, className = "") {
  return `<span class="icon ${className}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.check}</svg></span>`;
}

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

// 接单员认证状态：0 未申请 / 1 待审核 / 2 待缴保证金 / 3 已认证 / 4 未通过 / 5 已退出
const ACCEPTOR_STATUS_TEXT = {
  0: "未认证",
  1: "审核中",
  2: "待缴保证金",
  3: "已认证",
  4: "审核未通过",
  5: "已退出",
};

function acceptorOf() {
  return state.user?.acceptor || null;
}

function acceptorMenuSubtitle() {
  const info = acceptorOf();
  if (!info) return "实名认证后可接单";
  if (info.can_accept) return "已认证 · 可接单";
  return info.status_text || ACCEPTOR_STATUS_TEXT[Number(info.status)] || "未认证";
}

function statusMeta(status, kind = "task") {
  const taskMap = {
    0: ["待接单", "green"],
    1: ["已接单", "blue"],
    2: ["进行中", "orange"],
    3: ["待确认", "orange"],
    4: ["已完成", "gray"],
    5: ["已取消", "gray"],
    6: ["申诉中", "red"],
  };
  const orderMap = {
    0: ["待支付", "orange"],
    1: ["进行中", "blue"],
    2: ["待确认", "orange"],
    3: ["已完成", "green"],
    4: ["已取消", "gray"],
    5: ["争议冻结", "red"],
  };
  const [text, color] = (kind === "order" ? orderMap : taskMap)[Number(status)] || ["处理中", "gray"];
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
  modal.innerHTML = content;
  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
  modal.innerHTML = "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (
    response.status === 401 &&
    path !== "/api/auth/login" &&
    state.token
  ) {
    state.token = "";
    localStorage.removeItem("sunshine_preview_token");
    await login();
    return api(path, options);
  }
  if (!response.ok || payload.code !== 200) {
    const error = new Error(payload.msg || "请求失败");
    // 附带 HTTP 状态码：接单被认证门槛拦截时前端要据此弹出"去认证"引导
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload.data;
}

async function login() {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: { code: "demo-user", nickname: "林小满", community: "阳光社区" },
  });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("sunshine_preview_token", data.token);
}

function setTabBar(visible) {
  tabBar.hidden = !visible;
  tabBar.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function taskCard(task) {
  return `
    <article class="task-card" data-task-id="${task.id}">
      <div class="task-top">
        <span class="pill">${escapeHtml(task.category_name)}</span>
        <span class="money">¥${money(task.reward)}</span>
      </div>
      <h3 class="task-title">${escapeHtml(task.title)}</h3>
      <p class="task-desc">${escapeHtml(task.description)}</p>
      <div class="route-box">
        <div class="route-line">
          <span class="route-dot"></span>
          <span class="route-text">${escapeHtml(task.pickup_address)}</span>
        </div>
        <div class="route-gap"></div>
        <div class="route-line">
          <span class="route-dot end"></span>
          <span class="route-text">${escapeHtml(task.delivery_address)}</span>
        </div>
      </div>
      <div class="task-foot">
        <span class="publisher">
          <span class="mini-avatar">${escapeHtml(task.publisher_name?.slice(-2))}</span>
          ${escapeHtml(task.publisher_name)} · ${Number(task.distance_km).toFixed(1)}km
        </span>
        <button class="text-action">查看详情 ›</button>
      </div>
    </article>
  `;
}

function renderHome() {
  state.view = "home";
  setTabBar(true);
  const tasks = state.tasks.slice(0, 3);
  const announcement = state.config?.announcements?.[0];
  app.innerHTML = `
    <section class="view">
      <header class="view-header">
        <div>
          <div class="location-title">阳光社区</div>
          <p class="view-subtitle">${escapeHtml(state.user?.nickname || "邻里")}，今天也来搭把手</p>
        </div>
        <button class="icon-button" data-action="messages">
          ${icon("bell")}
          ${state.user?.stats?.unread ? `<span class="badge">${state.user.stats.unread}</span>` : ""}
        </button>
      </header>

      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">SUNSHINE NEIGHBORHOOD</div>
          <h2>顺路帮个忙，<br>让邻里更近一步</h2>
          <p>发布一件小事，等待邻里接单，费用托管更安心。</p>
          <button class="primary-button hero-button" data-view="publish">发布跑腿</button>
        </div>
        <div class="hero-scene" aria-hidden="true">
          <div class="hero-sun"></div>
          <div class="hero-building"></div>
          <div class="hero-tree"></div>
        </div>
      </section>

      ${
        announcement
          ? `<div class="announcement">
              <span class="announcement-label">社区公告</span>
              <span class="announcement-text">${escapeHtml(announcement.title)}</span>
            </div>`
          : ""
      }

      <section class="section">
        <div class="section-head">
          <h3 class="section-title">快捷服务</h3>
          <button class="section-link" data-view="tasks">全部服务</button>
        </div>
        <div class="category-grid">
          ${state.categories
            .map(
              (category) => `
                <button class="category-button" data-category="${category.id}">
                  <span class="category-icon">${escapeHtml(category.name[0])}</span>
                  ${escapeHtml(category.name)}
                </button>
              `,
            )
            .join("")}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h3 class="section-title">附近急单</h3>
            <p class="view-subtitle">按发布时间为你推荐</p>
          </div>
          <button class="section-link" data-view="tasks">查看更多</button>
        </div>
        <div class="task-list">${tasks.map(taskCard).join("")}</div>
      </section>
    </section>
  `;
}

async function loadTasks() {
  const query = new URLSearchParams({
    sort: state.taskSort,
    pageSize: "50",
  });
  if (state.taskCategoryId) query.set("categoryId", state.taskCategoryId);
  if (state.taskKeyword) query.set("keyword", state.taskKeyword);
  const data = await api(`/api/tasks?${query}`);
  state.tasks = data.list;
}

async function renderTasks(resetScroll = true) {
  state.view = "tasks";
  setTabBar(true);
  if (!state.tasks.length) await loadTasks();
  if (resetScroll) window.scrollTo({ top: 0 });
  app.innerHTML = `
    <section class="view">
      <header class="view-header">
        <div>
          <h1 class="view-title">任务大厅</h1>
          <p class="view-subtitle">${state.tasks.length} 件邻里任务等待帮忙</p>
        </div>
        <button class="primary-button" data-view="publish">＋ 发布</button>
      </header>
      <div class="search-bar">
        ${icon("search")}
        <input id="taskKeyword" value="${escapeHtml(state.taskKeyword)}" placeholder="搜索快递、买菜、喂养...">
      </div>
      <div class="chips">
        <button class="chip ${state.taskCategoryId === 0 ? "active" : ""}" data-category="0">全部</button>
        ${state.categories
          .map(
            (category) => `
              <button class="chip ${state.taskCategoryId === Number(category.id) ? "active" : ""}" data-category="${category.id}">
                ${escapeHtml(category.name)}
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="sort-row">
        ${[
          ["newest", "最新发布"],
          ["reward", "报酬优先"],
          ["deadline", "时间优先"],
          ["distance", "距离优先"],
        ]
          .map(
            ([value, text]) =>
              `<button class="sort-button ${state.taskSort === value ? "active" : ""}" data-sort="${value}">${text}</button>`,
          )
          .join("")}
      </div>
      <div class="task-list">
        ${state.tasks.length ? state.tasks.map(taskCard).join("") : '<div class="empty-state"><strong>没有匹配任务</strong>换个分类再找找</div>'}
      </div>
    </section>
  `;
}

function renderPublish() {
  state.view = "publish";
  state.publishImages = [];
  setTabBar(true);
  app.innerHTML = `
    <section class="view">
      <header class="view-header">
        <div>
          <h1 class="view-title">发布邻里任务</h1>
          <p class="view-subtitle">信息写清楚，邻居更容易快速接单</p>
        </div>
      </header>
      <form class="form-card" id="publishForm">
        <div class="field">
          <label class="field-label">选择服务类型</label>
          <div class="category-picker">
            ${state.categories
              .map(
                (category, index) => `
                  <button type="button" class="category-option ${index === 0 ? "active" : ""}" data-form-category="${category.id}">
                    ${escapeHtml(category.name)}
                  </button>
                `,
              )
              .join("")}
          </div>
          <input type="hidden" name="categoryId" value="${state.categories[0]?.id || ""}">
        </div>
        <div class="field">
          <label class="field-label">任务标题</label>
          <input class="input" name="title" maxlength="30" placeholder="例如：帮忙取一下丰巢快递" required>
        </div>
        <div class="field">
          <label class="field-label">任务说明</label>
          <textarea class="textarea" name="description" maxlength="300" placeholder="说明物品、数量、注意事项和取件方式"></textarea>
        </div>
        <div class="field">
          <label class="field-label">取件 / 服务地址</label>
          <input class="input" name="pickupAddress" placeholder="例如：东门丰巢柜" required>
        </div>
        <div class="field">
          <label class="field-label">送达地址</label>
          <input class="input" name="deliveryAddress" placeholder="例如：12栋2单元602" required>
        </div>
        <div class="two-columns">
          <div class="field">
            <label class="field-label">联系人</label>
            <input class="input" name="contactName" value="${escapeHtml(state.user?.nickname || "")}">
          </div>
          <div class="field">
            <label class="field-label">联系电话</label>
            <input class="input" name="contactPhone" value="${escapeHtml(state.user?.phone || "")}">
          </div>
        </div>
        <div class="field">
          <label class="field-label">期望完成时间</label>
          <input class="input" type="datetime-local" name="expectTime">
        </div>
        <div class="field">
          <label class="field-label">现场图片（可选，最多 3 张）</label>
          <input class="input" type="file" id="publishImages" accept="image/png,image/jpeg,image/webp" multiple>
          <div id="publishImagePreview" class="image-preview-row"></div>
        </div>
        <div class="field">
          <label class="field-label">跑腿报酬</label>
          <div class="quick-rewards">
            ${[5, 8, 12, 20]
              .map(
                (value) =>
                  `<button type="button" class="reward-button" data-reward="${value}">¥${value}</button>`,
              )
              .join("")}
          </div>
          <input class="input" style="margin-top:9px" type="number" min="1" max="5000" name="reward" placeholder="输入自定义金额" required>
        </div>
        <div class="inline-note">报酬先进入平台托管，服务完成并经发布者确认后，再结算给接单邻居。</div>
      </form>
      <div class="submit-bar">
        <button class="primary-button" id="submitPublish">确认发布并托管报酬</button>
      </div>
    </section>
  `;
}

async function renderOrders() {
  state.view = "orders";
  setTabBar(true);
  const data = await api(`/api/orders?role=${state.orderRole}`);
  state.orders = Array.isArray(data) ? data : data.list || [];
  window.scrollTo({ top: 0 });
  app.innerHTML = `
    <section class="view">
      <header class="view-header">
        <div>
          <h1 class="view-title">我的订单</h1>
          <p class="view-subtitle">跟进服务进度，及时确认与评价</p>
        </div>
      </header>
      <div class="role-switch">
        <button class="role-button ${state.orderRole === "published" ? "active" : ""}" data-order-role="published">我发布的</button>
        <button class="role-button ${state.orderRole === "accepted" ? "active" : ""}" data-order-role="accepted">我接取的</button>
      </div>
      <div class="order-list">
        ${
          state.orders.length
            ? state.orders
                .map(
                  (order) => `
                    <article class="order-card" data-order-id="${order.id}">
                      <div class="order-top">
                        <span class="order-no">${escapeHtml(order.order_no)}</span>
                        ${statusMeta(order.status, "order")}
                      </div>
                      <h3 class="order-title">${escapeHtml(order.title)}</h3>
                      <p class="order-desc">${escapeHtml(order.description)}</p>
                      <div class="order-foot">
                        <span class="publisher">${state.orderRole === "published" ? "接单" : "发布"} · ${escapeHtml(
                          state.orderRole === "published" ? order.acceptor_name : order.publisher_name,
                        )}</span>
                        <span class="money">¥${money(order.amount)}</span>
                      </div>
                    </article>
                  `,
                )
                .join("")
            : '<div class="empty-state"><strong>暂无订单</strong>完成一次发布或接单后会显示在这里</div>'
        }
      </div>
    </section>
  `;
}

async function refreshProfile() {
  state.user = await api("/api/user/profile");
}

async function renderProfile() {
  state.view = "profile";
  setTabBar(true);
  await refreshProfile();
  window.scrollTo({ top: 0 });
  app.innerHTML = `
    <section class="view">
      <header class="view-header">
        <div>
          <h1 class="view-title">个人中心</h1>
          <p class="view-subtitle">管理资料、钱包与邻里服务记录</p>
        </div>
      </header>
      <section class="profile-hero">
        <div class="profile-row">
          <div class="profile-avatar">${escapeHtml(state.user.nickname.slice(-2))}</div>
          <div style="flex:1">
            <h2 class="profile-name">${escapeHtml(state.user.nickname)}</h2>
            <div class="credit">信用 ${state.user.credit_score}</div>
            <p class="view-subtitle">${escapeHtml(state.user.community)} · ${escapeHtml(state.user.building + state.user.room)}</p>
            <p class="view-subtitle">UID ${escapeHtml(state.user.uid || `SQ${100000 + Number(state.user.id || 0)}`)}</p>
          </div>
        </div>
        <div class="wallet-summary">
          <div>
            <div class="view-subtitle">可用余额</div>
            <div class="balance">¥ ${money(state.user.balance)}</div>
          </div>
          <button class="text-action" data-action="wallet">收支明细 ›</button>
        </div>
      </section>
      <section class="stats-card">
        <div class="stat"><strong>${state.user.stats.published}</strong><small>我发布的</small></div>
        <div class="stat"><strong>${state.user.stats.accepted}</strong><small>我接取的</small></div>
        <div class="stat"><strong>${state.user.stats.completed}</strong><small>已完成</small></div>
      </section>
      ${
        acceptorOf()?.can_accept
          ? `<section class="info-card" style="margin-top:12px">
              <div class="row-between">
                <div>
                  <strong>接单员已认证</strong>
                  <p class="view-subtitle">保证金 ¥${money(acceptorOf().required_deposit)} 托管中，可正常接单</p>
                </div>
                <span class="status green">可接单</span>
              </div>
            </section>`
          : `<section class="info-card" style="margin-top:12px">
              <strong>你还不是接单员</strong>
              <p class="view-subtitle">${escapeHtml(acceptorOf()?.blocked_reason || "完成实名认证并缴纳保证金后，才能接取邻居的跑腿单")}</p>
              <button class="primary-button" style="margin-top:10px" data-action="acceptor">${Number(acceptorOf()?.status) === 1 ? "查看审核进度" : "申请成为接单员"}</button>
            </section>`
      }
      <div class="menu-list">
        ${[
          ["acceptor", "证", "接单员认证", acceptorMenuSubtitle()],
          ["messages", "信", "消息中心", "订单进度与社区通知"],
          ["wallet", "¥", "我的钱包", "余额与收支明细"],
          ["addresses", "址", "常用地址", "管理服务与收件地址"],
          ["reviews", "评", "我的评价", "查看收到的邻里评价"],
          ["complaints", "诉", "投诉记录", "查看投诉与处理结果"],
        ]
          .map(
            ([key, mark, title, subtitle]) => `
              <button class="menu-row" data-action="${key}">
                <span class="menu-icon">${mark}</span>
                <span class="menu-copy"><strong>${title}</strong><small>${subtitle}</small></span>
                <span>›</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

async function openTask(id) {
  const task = await api(`/api/tasks/${id}`);
  openModal(`
    <div class="detail-task">
      <div class="detail-hero">
        <div class="row-between">
          <span class="pill">${escapeHtml(task.category_name)}</span>
          ${statusMeta(task.status)}
        </div>
        <h2 class="detail-title">${escapeHtml(task.title)}</h2>
        <div class="row-between" style="margin-top:16px">
          <span class="view-subtitle">任务报酬</span>
          <span class="money" style="font-size:26px">¥${money(task.reward)}</span>
        </div>
      </div>
      <div class="info-card" style="margin-top:12px">
        <h3 class="section-title">任务说明</h3>
        <p class="order-desc">${escapeHtml(task.description)}</p>
        <div class="route-box">
          <div class="route-line"><span class="route-dot"></span><span class="route-text">${escapeHtml(task.pickup_address)}</span></div>
          <div class="route-gap"></div>
          <div class="route-line"><span class="route-dot end"></span><span class="route-text">${escapeHtml(task.delivery_address)}</span></div>
        </div>
        <div class="inline-note">期望完成：${escapeHtml(task.expect_time || "待协商")} · 发布者：${escapeHtml(task.publisher_name)}</div>
      </div>
      ${
        task.accept_blocked_reason
          ? `<p class="inline-note" style="color:#C9861A;margin-top:10px">${escapeHtml(task.accept_blocked_reason)}</p>`
          : ""
      }
      <div class="modal-actions">
        <button class="ghost-button" data-modal-close>关闭</button>
        ${
          task.can_accept
            ? `<button class="primary-button" data-accept-task="${task.id}">立即接单</button>`
            : task.accept_blocked_reason
              ? `<button class="primary-button" data-go-acceptor>去认证后接单</button>`
              : `<button class="primary-button" disabled>${task.publisher_id === state.user?.id ? "我发布的任务" : "当前不可接单"}</button>`
        }
      </div>
    </div>
  `);
}

async function openOrder(id) {
  const order = await api(`/api/orders/${id}`);
  const isPublisher = Number(order.publisher_id) === Number(state.user.id);
  const isAcceptor = Number(order.acceptor_id) === Number(state.user.id);
  const reviewed = order.reviews.some((review) => Number(review.reviewer_id) === Number(state.user.id));
  openModal(`
    <div>
      <div class="detail-hero">
        <div class="row-between">${statusMeta(order.status, "order")}<span class="order-no">${escapeHtml(order.order_no)}</span></div>
        <h2 class="detail-title">${escapeHtml(order.title)}</h2>
        <p class="view-subtitle">${escapeHtml(order.description)}</p>
        <div class="route-box">
          <div class="route-line"><span class="route-dot"></span><span class="route-text">${escapeHtml(order.pickup_address)}</span></div>
          <div class="route-gap"></div>
          <div class="route-line"><span class="route-dot end"></span><span class="route-text">${escapeHtml(order.delivery_address)}</span></div>
        </div>
      </div>
      <div class="info-card" style="margin-top:12px">
        <div class="row-between"><span>发布者</span><strong>${escapeHtml(order.publisher_name)}</strong></div>
        <div class="row-between" style="margin-top:10px"><span>接单邻居</span><strong>${escapeHtml(order.acceptor_name)}</strong></div>
        <div class="row-between" style="margin-top:10px"><span>订单金额</span><strong class="money">¥${money(order.amount)}</strong></div>
      </div>
      ${
        order.status === 5
          ? '<p class="view-subtitle" style="margin-top:10px;color:#EA6668">订单争议处理中，托管资金已冻结，等待管理员裁决。</p>'
          : ""
      }
      <div class="modal-actions">
        ${
          isAcceptor && order.status === 1
            ? `<button class="primary-button" data-order-action="start" data-id="${order.id}">开始服务</button>`
            : ""
        }
        ${
          isAcceptor && order.task_status === 2 && order.status === 2
            ? `<button class="primary-button" data-order-action="finish" data-id="${order.id}">提交完成</button>`
            : ""
        }
        ${
          isPublisher && order.task_status === 3 && order.status === 2
            ? `<button class="primary-button" data-order-action="confirm" data-id="${order.id}">确认结算</button>`
            : ""
        }
        ${
          order.status === 3 && !reviewed
            ? `<button class="secondary-button" data-review="${order.id}">去评价</button>`
            : ""
        }
        <button class="ghost-button" data-modal-close>关闭</button>
      </div>
    </div>
  `);
}

async function openPanel(type) {
  if (type === "acceptor") {
    const info = await api("/api/acceptor/profile");
    const status = Number(info.status);
    const profile = info.profile;
    const stickerColor = status === 3 ? "green" : [1, 2].includes(status) ? "orange" : status === 4 ? "red" : "gray";
    // 演示用：证件照片预填示例图，避免演示时还要临时找图片文件
    state.acceptorFront = state.acceptorFront || "/preview/demo-proof.svg";
    state.acceptorBack = state.acceptorBack || "/preview/demo-proof.svg";
    const canApply = [0, 4, 5].includes(status);
    openModal(`
      <h2 class="modal-title">接单员认证</h2>
      <p class="modal-note">完成实名认证并缴纳 ¥${money(info.required_deposit)} 保证金后才能接单；保证金在退出时原路退还</p>
      <div class="info-card">
        <div class="row-between">
          <span>当前状态</span>
          <span class="status ${stickerColor}">${escapeHtml(info.status_text || ACCEPTOR_STATUS_TEXT[status])}</span>
        </div>
        ${
          profile
            ? `
        <div class="row-between" style="margin-top:10px"><span>真实姓名</span><strong>${escapeHtml(profile.real_name)}</strong></div>
        <div class="row-between" style="margin-top:10px"><span>身份证号</span><strong>${escapeHtml(profile.id_card_masked)}</strong></div>
        <div class="row-between" style="margin-top:10px"><span>联系手机号</span><strong>${escapeHtml(profile.phone)}</strong></div>
        <div class="row-between" style="margin-top:10px"><span>保证金</span><strong>¥${money(profile.deposit_amount)}</strong></div>`
            : `<p class="view-subtitle" style="margin-top:10px">你还没有提交过认证资料。认证需要身份证号、手机号和身份证正反面照片。</p>`
        }
      </div>
      ${
        canApply
          ? `
      <div class="info-card" style="margin-top:12px">
        <h3 class="section-title">填写实名信息</h3>
        <div class="field"><label class="field-label">真实姓名</label><input class="input" id="acceptorName" placeholder="需与身份证一致" value="${escapeHtml(profile?.real_name || "")}"></div>
        <div class="field"><label class="field-label">身份证号</label><input class="input" id="acceptorIdCard" maxlength="18" inputmode="numeric" placeholder="18 位身份证号"></div>
        <div class="field"><label class="field-label">联系手机号</label><input class="input" id="acceptorPhone" maxlength="11" inputmode="numeric" placeholder="11 位手机号" value="${escapeHtml(profile?.phone || state.user?.phone || "")}"></div>
        <div class="field"><label class="field-label">紧急联系人（选填）</label><input class="input" id="acceptorEmergency" placeholder="姓名与联系电话" value="${escapeHtml(profile?.emergency_contact || "")}"></div>
        <div class="field">
          <label class="field-label">身份证照片（演示已预填示例图，可点击下方按钮更换）</label>
          <div class="image-preview-row">
            <img class="image-preview-thumb" id="acceptorPhotoFront" src="${escapeHtml(state.acceptorFront)}" alt="身份证正面">
            <img class="image-preview-thumb" id="acceptorPhotoBack" src="${escapeHtml(state.acceptorBack)}" alt="身份证反面">
          </div>
          <div class="two-columns" style="margin-top:8px">
            <label class="ghost-button" style="text-align:center">更换正面<input type="file" accept="image/*" hidden id="acceptorFrontFile"></label>
            <label class="ghost-button" style="text-align:center">更换反面<input type="file" accept="image/*" hidden id="acceptorBackFile"></label>
          </div>
        </div>
        <p class="inline-note">身份证号仅用于实名核验，展示与接口返回一律脱敏，完整号码只有超级管理员可查看且会记录日志。</p>
        ${status === 4 && profile?.review_note ? `<p class="inline-note" style="color:#EA6668">上次未通过原因：${escapeHtml(profile.review_note)}</p>` : ""}
      </div>
      <div class="modal-actions">
        <button class="ghost-button" data-modal-close>取消</button>
        <button class="primary-button" data-submit-acceptor>提交认证申请</button>
      </div>`
          : ""
      }
      ${
        status === 1
          ? `<div class="info-card" style="margin-top:12px">
              <p class="view-subtitle">资料已提交，管理员核验通过后即可缴纳保证金。审核期间你仍然可以正常发布任务。</p>
            </div>
            <div class="modal-actions"><button class="ghost-button" data-modal-close>关闭</button></div>`
          : ""
      }
      ${
        status === 2
          ? `<div class="info-card" style="margin-top:12px">
              <div class="row-between"><span>实名认证</span><span class="status green">已通过</span></div>
              <p class="view-subtitle" style="margin-top:10px">缴纳 ¥${money(info.required_deposit)} 保证金后即可开始接单，保证金在退出时原路退还。</p>
              <div class="wallet-summary"><div><div class="view-subtitle">当前可用余额</div><div class="balance">¥ ${money(state.user?.balance)}</div></div></div>
            </div>
            <div class="modal-actions">
              <button class="ghost-button" data-modal-close>稍后缴纳</button>
              <button class="primary-button" data-pay-deposit>缴纳保证金 ¥${money(info.required_deposit)}</button>
            </div>`
          : ""
      }
      ${
        status === 3
          ? `<div class="info-card" style="margin-top:12px">
              <div class="row-between"><span>接单资格</span><span class="status green">可接单</span></div>
              <p class="view-subtitle" style="margin-top:10px">保证金 ¥${money(profile?.deposit_amount)} 托管中。退出接单员后保证金将立即退回钱包余额，但需先结清进行中的订单。</p>
            </div>
            <div class="modal-actions">
              <button class="ghost-button" data-modal-close>关闭</button>
              <button class="danger-button" data-quit-acceptor>退出接单员并退还保证金</button>
            </div>`
          : ""
      }
    `);
    return;
  }

  if (type === "messages") {
    const messages = await api("/api/messages");
    openModal(`
      <h2 class="modal-title">消息中心</h2>
      <p class="modal-note">订单和任务状态变化会及时通知你</p>
      <div class="message-list">
        ${
          messages.length
            ? messages
                .map(
                  (item) => `
                    <article class="message-card ${item.is_read ? "" : "unread"}">
                      <span class="menu-icon">信</span>
                      <div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.content)}</p><div class="muted">${escapeHtml(item.created_at)}</div></div>
                    </article>
                  `,
                )
                .join("")
            : '<div class="empty-state">暂无消息</div>'
        }
      </div>
      <div class="modal-actions"><button class="secondary-button" data-action="read-all">全部已读</button><button class="ghost-button" data-modal-close>关闭</button></div>
    `);
    return;
  }

  if (type === "wallet") {
    const wallet = await api("/api/wallet");
    openModal(`
      <h2 class="modal-title">我的钱包</h2>
      <p class="modal-note">可用余额 <strong style="color:#2f8055">¥${money(wallet.balance)}</strong></p>
      <div class="wallet-card">
        ${
          wallet.records.length
            ? wallet.records
                .map(
                  (record) => `
                    <div class="wallet-item">
                      <span class="wallet-mark ${record.type === 2 ? "expense" : ""}">${record.type === 2 ? "支" : "收"}</span>
                      <div style="flex:1"><strong>${escapeHtml(record.remark)}</strong><div class="muted">${escapeHtml(record.created_at)}</div></div>
                      <span class="amount ${record.type === 2 ? "expense" : ""}">${record.amount >= 0 ? "+" : ""}¥${money(record.amount)}</span>
                    </div>
                  `,
                )
                .join("")
            : "暂无流水"
        }
      </div>
      <div class="modal-actions"><button class="ghost-button" data-modal-close>关闭</button></div>
    `);
    return;
  }

  if (type === "addresses") {
    const addresses = await api("/api/addresses");
    openModal(`
      <h2 class="modal-title">常用地址</h2>
      <p class="modal-note">地址会用于发布任务和服务联系</p>
      <div class="address-list">
        ${
          addresses.length
            ? addresses
                .map(
                  (address) => `
                    <article class="address-card">
                      <h4>${escapeHtml(address.contact_name)} · ${escapeHtml(address.phone)}</h4>
                      <p>${escapeHtml(`${address.community} ${address.building} ${address.room} ${address.detail}`)}</p>
                    </article>
                  `,
                )
                .join("")
            : '<div class="empty-state">暂无常用地址</div>'
        }
      </div>
      <div class="modal-actions"><button class="ghost-button" data-modal-close>关闭</button></div>
    `);
    return;
  }

  if (type === "reviews") {
    const reviews = await api("/api/reviews");
    openModal(`
      <h2 class="modal-title">我的评价</h2>
      <p class="modal-note">这些是邻里对你在平台服务的反馈</p>
      <div class="review-list">
        ${
          reviews.length
            ? reviews
                .map(
                  (review) => `
                    <article class="review-card">
                      <div class="row-between"><h4>${escapeHtml(review.reviewer_name)}</h4><strong>${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</strong></div>
                      <p>${escapeHtml(review.content || "对方没有填写文字评价")}</p>
                      <div class="muted">${escapeHtml(review.task_title)} · ${escapeHtml(review.created_at)}</div>
                    </article>
                  `,
                )
                .join("")
            : '<div class="empty-state">暂无评价</div>'
        }
      </div>
      <div class="modal-actions"><button class="ghost-button" data-modal-close>关闭</button></div>
    `);
    return;
  }

  if (type === "complaints") {
    const complaints = await api("/api/complaints");
    openModal(`
      <h2 class="modal-title">投诉记录</h2>
      <p class="modal-note">管理员处理进度会同步显示</p>
      <div class="complaint-list">
        ${
          complaints.length
            ? complaints
                .map(
                  (item) => `
                    <article class="complaint-card">
                      <div class="row-between"><h4>${escapeHtml(item.reason)}</h4><span class="status ${Number(item.status) === 2 ? "green" : "orange"}">${Number(item.status) === 2 ? "已处理" : "处理中"}</span></div>
                      <p>${escapeHtml(item.description)}</p>
                      <div class="inline-note">${escapeHtml(item.handle_result || "管理员正在处理中")}</div>
                    </article>
                  `,
                )
                .join("")
            : '<div class="empty-state">暂无投诉记录</div>'
        }
      </div>
      <div class="modal-actions"><button class="ghost-button" data-modal-close>关闭</button></div>
    `);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handlePublishImagesChange(event) {
  const files = Array.from(event.target.files || []).slice(0, 3 - (state.publishImages || []).length);
  const preview = document.getElementById("publishImagePreview");
  for (const file of files) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await api("/api/upload", { method: "POST", body: { dataUrl } });
      state.publishImages = (state.publishImages || []).concat(result.url);
      if (preview) {
        preview.insertAdjacentHTML(
          "beforeend",
          `<img class="image-preview-thumb" src="${result.url}" alt="预览图">`,
        );
      }
    } catch (error) {
      showToast(error.message || "图片上传失败");
    }
  }
  event.target.value = "";
}

async function handleAcceptorPhotoChange(event, side) {
  const file = (event.target.files || [])[0];
  if (!file) return;
  const preview = document.getElementById(side === "front" ? "acceptorPhotoFront" : "acceptorPhotoBack");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const result = await api("/api/upload", { method: "POST", body: { dataUrl } });
    if (side === "front") state.acceptorFront = result.url;
    else state.acceptorBack = result.url;
    if (preview) preview.src = result.url;
    showToast("证件照片已更新");
  } catch (error) {
    showToast(error.message || "图片上传失败");
  }
  event.target.value = "";
}

// 提交实名认证申请。身份证号与照片只在提交时上行一次，
// 之后所有读取路径返回的都是脱敏号码。
async function submitAcceptorApply() {
  const realName = document.getElementById("acceptorName")?.value.trim() || "";
  const idCardNo = document.getElementById("acceptorIdCard")?.value.trim() || "";
  const phone = document.getElementById("acceptorPhone")?.value.trim() || "";
  const emergencyContact = document.getElementById("acceptorEmergency")?.value.trim() || "";
  if (!realName || !idCardNo || !phone) {
    showToast("请填写真实姓名、身份证号与手机号");
    return;
  }
  try {
    await api("/api/acceptor/apply", {
      method: "POST",
      body: {
        realName,
        idCardNo,
        phone,
        emergencyContact,
        idCardFront: state.acceptorFront,
        idCardBack: state.acceptorBack,
      },
    });
    showToast("认证资料已提交，请等待管理员审核");
    closeModal();
    await refreshProfile();
    await renderProfile();
  } catch (error) {
    showToast(error.message);
  }
}

async function payAcceptorDeposit() {
  try {
    await api("/api/acceptor/deposit", { method: "POST" });
    showToast("保证金已缴纳，你现在可以接单了");
    closeModal();
    await Promise.all([refreshProfile(), loadTasks()]);
    await renderProfile();
  } catch (error) {
    showToast(error.message);
  }
}

async function quitAcceptor() {
  try {
    await api("/api/acceptor/quit", { method: "POST" });
    showToast("已退出接单员，保证金已退回余额");
    closeModal();
    await Promise.all([refreshProfile(), loadTasks()]);
    await renderProfile();
  } catch (error) {
    showToast(error.message);
  }
}

async function publishTask() {
  const form = document.getElementById("publishForm");
  const values = new FormData(form);
  const body = Object.fromEntries(values.entries());
  body.categoryId = Number(body.categoryId);
  body.reward = Number(body.reward);
  body.images = state.publishImages || [];
  if (!body.categoryId || !body.title || !body.pickupAddress || !body.deliveryAddress || !body.reward) {
    showToast("请完整填写任务信息");
    return;
  }
  try {
    await api("/api/tasks", { method: "POST", body });
    showToast("任务已发布并完成托管");
    await Promise.all([loadTasks(), refreshProfile()]);
    state.orderRole = "published";
    await renderOrders();
  } catch (error) {
    showToast(error.message);
  }
}

async function acceptTask(id) {
  try {
    const order = await api(`/api/tasks/${id}/accept`, { method: "POST" });
    showToast("接单成功");
    closeModal();
    await Promise.all([loadTasks(), refreshProfile()]);
    state.orderRole = "accepted";
    await openOrder(order.id);
  } catch (error) {
    // 被实名认证/保证金门槛拦截（403）时，直接引导到认证面板，而不是只弹一句报错
    if (error.status === 403) {
      showToast(error.message);
      closeModal();
      await openPanel("acceptor");
      return;
    }
    showToast(error.message);
  }
}

async function handleOrderAction(action, id) {
  try {
    const options = { method: "POST", body: {} };
    if (action === "finish") options.body = { images: ["/preview/demo-proof.svg"] };
    await api(`/api/orders/${id}/${action}`, options);
    showToast(action === "confirm" ? "订单已完成并结算" : action === "finish" ? "完成凭证已提交" : "服务已开始");
    closeModal();
    await renderOrders();
    await openOrder(id);
  } catch (error) {
    showToast(error.message);
  }
}

async function submitReview(orderId) {
  const rating = Number(modal.querySelector("[data-rating].active")?.dataset.rating || 5);
  const content = modal.querySelector("#reviewContent")?.value || "";
  try {
    await api(`/api/orders/${orderId}/review`, { method: "POST", body: { rating, content, tags: [] } });
    showToast("评价已提交");
    closeModal();
  } catch (error) {
    showToast(error.message);
  }
}

app.addEventListener("click", async (event) => {
  const viewTarget = event.target.closest("[data-view]");
  if (viewTarget) {
    const view = viewTarget.dataset.view;
    if (view === "home") {
      await Promise.all([loadTasks(), refreshProfile()]);
      renderHome();
    } else if (view === "tasks") {
      await renderTasks();
    } else if (view === "publish") {
      renderPublish();
    } else if (view === "orders") {
      await renderOrders();
    } else if (view === "profile") {
      await renderProfile();
    }
    return;
  }

  const categoryTarget = event.target.closest("[data-category]");
  if (categoryTarget) {
    state.taskCategoryId = Number(categoryTarget.dataset.category);
    await loadTasks();
    await renderTasks();
    return;
  }

  const sortTarget = event.target.closest("[data-sort]");
  if (sortTarget) {
    state.taskSort = sortTarget.dataset.sort;
    await loadTasks();
    await renderTasks(false);
    return;
  }

  const taskTarget = event.target.closest("[data-task-id]");
  if (taskTarget && !event.target.closest("[data-accept-task]")) {
    await openTask(taskTarget.dataset.taskId);
    return;
  }

  const acceptTarget = event.target.closest("[data-accept-task]");
  if (acceptTarget) {
    await acceptTask(acceptTarget.dataset.acceptTask);
    return;
  }

  const orderTarget = event.target.closest("[data-order-id]");
  if (orderTarget) {
    await openOrder(orderTarget.dataset.orderId);
    return;
  }

  const roleTarget = event.target.closest("[data-order-role]");
  if (roleTarget) {
    state.orderRole = roleTarget.dataset.orderRole;
    await renderOrders();
    return;
  }

  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget) {
    const action = actionTarget.dataset.action;
    if (action === "read-all") {
      await api("/api/messages/read-all", { method: "POST" });
      await refreshProfile();
      showToast("已全部标为已读");
      closeModal();
    } else {
      await openPanel(action);
    }
    return;
  }

  const orderAction = event.target.closest("[data-order-action]");
  if (orderAction) {
    await handleOrderAction(orderAction.dataset.orderAction, orderAction.dataset.id);
    return;
  }

  const reviewTarget = event.target.closest("[data-review]");
  if (reviewTarget) {
    const orderId = reviewTarget.dataset.review;
    modal.innerHTML = `
      <h2 class="modal-title">评价本次服务</h2>
      <p class="modal-note">评分与文字评价会帮助建立邻里信用</p>
      <div class="quick-rewards" style="grid-template-columns:repeat(5,1fr)">
        ${[1, 2, 3, 4, 5]
          .map(
            (rating) =>
              `<button class="reward-button ${rating === 5 ? "active" : ""}" data-rating="${rating}">${rating}★</button>`,
          )
          .join("")}
      </div>
      <textarea class="textarea" id="reviewContent" style="margin-top:12px" placeholder="说说这次邻里互助的感受"></textarea>
      <div class="modal-actions"><button class="primary-button" data-submit-review="${orderId}">提交评价</button><button class="ghost-button" data-modal-close>取消</button></div>
    `;
    return;
  }

  const ratingTarget = event.target.closest("[data-rating]");
  if (ratingTarget) {
    modal.querySelectorAll("[data-rating]").forEach((item) => item.classList.remove("active"));
    ratingTarget.classList.add("active");
    return;
  }

  const reviewSubmit = event.target.closest("[data-submit-review]");
  if (reviewSubmit) {
    await submitReview(reviewSubmit.dataset.submitReview);
    return;
  }

  if (event.target.closest("[data-modal-close]")) closeModal();
});

app.addEventListener("click", (event) => {
  const category = event.target.closest("[data-form-category]");
  if (category) {
    document.querySelectorAll("[data-form-category]").forEach((button) => button.classList.remove("active"));
    category.classList.add("active");
    document.querySelector('input[name="categoryId"]').value = category.dataset.formCategory;
  }
  const reward = event.target.closest("[data-reward]");
  if (reward) {
    document.querySelectorAll("[data-reward]").forEach((button) => button.classList.remove("active"));
    reward.classList.add("active");
    document.querySelector('input[name="reward"]').value = reward.dataset.reward;
  }
});

app.addEventListener("submit", (event) => {
  if (event.target.id === "publishForm") {
    event.preventDefault();
    publishTask();
  }
});

app.addEventListener("keydown", async (event) => {
  if (event.target.id === "taskKeyword" && event.key === "Enter") {
    state.taskKeyword = event.target.value.trim();
    await loadTasks();
    await renderTasks();
  }
});

app.addEventListener("click", async (event) => {
  if (event.target.id === "submitPublish") {
    await publishTask();
  }
});

app.addEventListener("change", async (event) => {
  if (event.target.id === "publishImages") {
    await handlePublishImagesChange(event);
  }
});

tabBar.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  const view = button.dataset.view;
  if (view === "home") {
    await Promise.all([loadTasks(), refreshProfile()]);
    renderHome();
  } else if (view === "tasks") await renderTasks();
  else if (view === "publish") renderPublish();
  else if (view === "orders") await renderOrders();
  else if (view === "profile") await renderProfile();
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop || event.target.closest("[data-modal-close]")) closeModal();
});

modalBackdrop.addEventListener("click", async (event) => {
  const acceptTarget = event.target.closest("[data-accept-task]");
  if (acceptTarget) {
    await acceptTask(acceptTarget.dataset.acceptTask);
    return;
  }

  const orderAction = event.target.closest("[data-order-action]");
  if (orderAction) {
    await handleOrderAction(orderAction.dataset.orderAction, orderAction.dataset.id);
    return;
  }

  const reviewTarget = event.target.closest("[data-review]");
  if (reviewTarget) {
    const orderId = reviewTarget.dataset.review;
    modal.innerHTML = `
      <h2 class="modal-title">评价本次服务</h2>
      <p class="modal-note">评分与文字评价会帮助建立邻里信用</p>
      <div class="quick-rewards" style="grid-template-columns:repeat(5,1fr)">
        ${[1, 2, 3, 4, 5]
          .map(
            (rating) =>
              `<button class="reward-button ${rating === 5 ? "active" : ""}" data-rating="${rating}">${rating}★</button>`,
          )
          .join("")}
      </div>
      <textarea class="textarea" id="reviewContent" style="margin-top:12px" placeholder="说说这次邻里互助的感受"></textarea>
      <div class="modal-actions"><button class="primary-button" data-submit-review="${orderId}">提交评价</button><button class="ghost-button" data-modal-close>取消</button></div>
    `;
    return;
  }

  const ratingTarget = event.target.closest("[data-rating]");
  if (ratingTarget && modal.contains(ratingTarget)) {
    modal.querySelectorAll("[data-rating]").forEach((item) => item.classList.remove("active"));
    ratingTarget.classList.add("active");
    return;
  }

  const reviewSubmit = event.target.closest("[data-submit-review]");
  if (reviewSubmit) {
    await submitReview(reviewSubmit.dataset.submitReview);
    return;
  }

  // 弹窗挂在 #app 之外，所以 #app 上的 data-action 分发接不到这里的事件。
  // 消息中心的"全部已读"就是靠这里兜底，否则按钮点了没反应。
  const modalAction = event.target.closest("[data-action]");
  if (modalAction && modal.contains(modalAction)) {
    const action = modalAction.dataset.action;
    if (action === "read-all") {
      await api("/api/messages/read-all", { method: "POST" });
      await refreshProfile();
      showToast("已全部标为已读");
      closeModal();
    } else {
      await openPanel(action);
    }
    return;
  }

  // ---- 接单员认证相关动作 ----
  // 任务详情里"去认证后接单"：关掉当前弹窗再打开认证面板
  if (event.target.closest("[data-go-acceptor]")) {
    await openPanel("acceptor");
    return;
  }

  if (event.target.closest("[data-submit-acceptor]")) {
    await submitAcceptorApply();
    return;
  }

  if (event.target.closest("[data-pay-deposit]")) {
    await payAcceptorDeposit();
    return;
  }

  if (event.target.closest("[data-quit-acceptor]")) {
    if (!window.confirm("退出接单员后保证金将退回余额，确定退出吗？")) return;
    await quitAcceptor();
    return;
  }
});

// 认证表单里的身份证正反面照片选择：弹窗挂在 modalBackdrop 下，需单独绑定
modalBackdrop.addEventListener("change", async (event) => {
  if (event.target.id === "acceptorFrontFile") {
    await handleAcceptorPhotoChange(event, "front");
  } else if (event.target.id === "acceptorBackFile") {
    await handleAcceptorPhotoChange(event, "back");
  }
});

async function init() {
  try {
    if (!state.token) await login();
    const [config, categories, tasks, user] = await Promise.all([
      api("/api/config"),
      api("/api/categories"),
      api("/api/tasks?sort=newest&pageSize=50"),
      api("/api/user/profile"),
    ]);
    state.config = config;
    state.categories = categories;
    state.tasks = tasks.list;
    state.user = user;
    renderHome();
  } catch (error) {
    app.innerHTML = `
      <div class="loading-screen">
        <div class="brand-mark">!</div>
        <strong>预览服务连接失败</strong>
        <span class="loading-text">${escapeHtml(error.message)}</span>
        <button class="primary-button" onclick="location.reload()">重新连接</button>
      </div>
    `;
  }
}

init();
