const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { hashPassword } = require("./auth");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const databasePath = process.env.DATABASE_PATH || path.join(dataDir, "sunshine.sqlite");
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

function now() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function transaction(action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseJson(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      openid TEXT UNIQUE,
      nickname TEXT NOT NULL,
      avatar_url TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      community TEXT DEFAULT '',
      building TEXT DEFAULT '',
      room TEXT DEFAULT '',
      credit_score INTEGER DEFAULT 100,
      balance REAL DEFAULT 0,
      role INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      color TEXT DEFAULT '#6DBF8A',
      address_mode INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publisher_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      pickup_address TEXT DEFAULT '',
      delivery_address TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      expect_time TEXT,
      reward REAL NOT NULL,
      images TEXT DEFAULT '[]',
      completion_images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 0,
      acceptor_id INTEGER,
      accepted_at TEXT,
      finished_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (publisher_id) REFERENCES users(id),
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (acceptor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      task_id INTEGER UNIQUE NOT NULL,
      publisher_id INTEGER NOT NULL,
      acceptor_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status INTEGER DEFAULT 1,
      pay_status INTEGER DEFAULT 1,
      frozen_status INTEGER,
      pay_time TEXT,
      confirm_time TEXT,
      cancel_reason TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (publisher_id) REFERENCES users(id),
      FOREIGN KEY (acceptor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_type INTEGER NOT NULL,
      operator_id INTEGER,
      operator_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id INTEGER,
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      reviewee_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      content TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (reviewer_id) REFERENCES users(id),
      FOREIGN KEY (reviewee_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      type INTEGER DEFAULT 1,
      related_id INTEGER,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      complainant_id INTEGER NOT NULL,
      respondent_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      description TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 0,
      handle_result TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      handled_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      community TEXT NOT NULL,
      building TEXT DEFAULT '',
      room TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      address_type INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS withdraw_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdraw_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status INTEGER DEFAULT 0,
      pay_mode TEXT DEFAULT 'mock',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS recharge_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recharge_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status INTEGER DEFAULT 0,
      pay_mode TEXT DEFAULT 'mock',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id INTEGER,
      type INTEGER NOT NULL,
      amount REAL NOT NULL,
      balance REAL NOT NULL,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS acceptor_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      real_name TEXT NOT NULL,
      id_card_no TEXT NOT NULL,
      id_card_front TEXT NOT NULL,
      id_card_back TEXT NOT NULL,
      phone TEXT NOT NULL,
      community TEXT DEFAULT '',
      emergency_contact TEXT DEFAULT '',
      status INTEGER NOT NULL DEFAULT 1,
      review_note TEXT DEFAULT '',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      deposit_amount REAL NOT NULL DEFAULT 0,
      deposit_status INTEGER NOT NULL DEFAULT 0,
      deposit_paid_at TEXT,
      deposit_refunded_at TEXT,
      applied_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_publisher ON orders(publisher_id);
    CREATE INDEX IF NOT EXISTS idx_orders_acceptor ON orders(acceptor_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON operation_logs(created_at);
    -- 同一身份证号只允许绑定一个账号，防止同一人开多个接单账号刷单
    CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptor_id_card ON acceptor_profiles(id_card_no);
    CREATE INDEX IF NOT EXISTS idx_acceptor_status ON acceptor_profiles(status);
  `);
}

function seed() {
  if (get("SELECT COUNT(*) AS total FROM users").total > 0) return false;

  const insertUser = db.prepare(`
    INSERT INTO users
      (openid, nickname, avatar_url, phone, community, building, room, credit_score, balance, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `);
  // 演示余额与下方钱包流水严格自洽：
  // 林小满 150-5(托管task5)=145；李师傅 130-50(保证金)-8(task1)=72；周小北 100-28(task2)-12(task6)=60；
  // 王老师 60-10(task3)=50；陈阿姨 60-6(task4)=54
  [
    ["demo-user", "林小满", "", "13800005621", "阳光社区", "12栋", "2单元 602", 98, 145],
    ["neighbor-li", "李师傅", "", "13900002048", "阳光社区", "8栋", "1单元 301", 100, 72],
    ["neighbor-zhou", "周小北", "", "13600007712", "阳光社区", "3栋", "2单元 1102", 96, 60],
    ["neighbor-wang", "王老师", "", "13700006530", "阳光社区", "15栋", "1单元 501", 99, 50],
    ["neighbor-chen", "陈阿姨", "", "13500001098", "阳光社区", "6栋", "3单元 202", 95, 54],
  ].forEach((item) => insertUser.run(...item));

  const insertCategory = db.prepare(
    "INSERT INTO categories (name, icon, color, sort, status) VALUES (?, ?, ?, ?, 1)",
  );
  [
    ["代取快递", "box", "#5EAD7D", 1],
    ["买菜代购", "basket", "#74B982", 2],
    ["宠物照护", "paw", "#49A6A0", 3],
    ["代扔垃圾", "trash", "#8BB277", 4],
    ["餐饮代取", "cup", "#D69D5B", 5],
    ["搬运跑腿", "cart", "#5E8F7A", 6],
  ].forEach((item) => insertCategory.run(...item));

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const afterTomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const format = (date) => date.toISOString().slice(0, 16).replace("T", " ");
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      publisher_id, category_id, title, description, pickup_address, delivery_address,
      contact_name, contact_phone, expect_time, reward, images, status, acceptor_id,
      accepted_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
  `);

  insertTask.run(
    2,
    1,
    "帮忙取一下丰巢快递",
    "两个小包裹，不重。取件码接单后发送，送到 12 栋门口即可。",
    "阳光社区东门丰巢柜",
    "阳光社区12栋2单元",
    "林女士",
    "13800005621",
    format(tomorrow),
    8,
    0,
    null,
    null,
    null,
    now(),
    now(),
  );
  insertTask.run(
    3,
    3,
    "周末帮忙喂猫和铲屎",
    "周六上午上门喂猫，添粮换水、清理猫砂。猫咪温顺，不会出门。",
    "阳光社区3栋2单元1102",
    "阳光社区3栋2单元1102",
    "周女士",
    "13600007712",
    format(afterTomorrow),
    28,
    0,
    null,
    null,
    null,
    now(),
    now(),
  );
  insertTask.run(
    4,
    2,
    "帮忙带一份青菜和鸡蛋",
    "小区西门生鲜店，青菜两把、鸡蛋一盒，费用另付，跑腿费 10 元。",
    "阳光社区西门外生鲜店",
    "阳光社区15栋1单元",
    "王老师",
    "13700006530",
    format(tomorrow),
    10,
    0,
    null,
    null,
    null,
    now(),
    now(),
  );
  insertTask.run(
    5,
    5,
    "顺路取两杯奶茶",
    "订单已付，去西门奶茶店报尾号 2736，送到 6 栋楼下。",
    "阳光社区西门奶茶店",
    "阳光社区6栋3单元",
    "陈阿姨",
    "13500001098",
    format(tomorrow),
    6,
    0,
    null,
    null,
    null,
    now(),
    now(),
  );
  insertTask.run(
    1,
    4,
    "晚饭后帮忙带下垃圾",
    "两袋生活垃圾，已打好结，送到北门分类投放点。",
    "阳光社区12栋2单元602门口",
    "阳光社区北门垃圾分类点",
    "林小满",
    "13800005621",
    format(tomorrow),
    5,
    1,
    2,
    now(),
    null,
    now(),
    now(),
  );
  insertTask.run(
    3,
    1,
    "帮取一份文件并送上门",
    "文件在物业前台，取到后送到 9 栋。",
    "阳光社区物业前台",
    "阳光社区9栋1单元",
    "周女士",
    "13600007712",
    format(tomorrow),
    12,
    3,
    // 接单者固定为已认证的李师傅（演示主账号林小满刻意保持未认证，
    // 因此不能是"未认证却有在进行中的接单"这种自相矛盾的演示数据）
    2,
    now(),
    now(),
    now(),
    now(),
  );

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      order_no, task_id, publisher_id, acceptor_id, amount, status, pay_status,
      pay_time, confirm_time, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertOrder.run("SQ202609110001", 5, 1, 2, 5, 1, 1, now(), null, now(), now());
  insertOrder.run("SQ202609110002", 6, 3, 2, 12, 2, 1, now(), null, now(), now());

  const insertAddress = db.prepare(`
    INSERT INTO addresses
      (user_id, contact_name, phone, community, building, room, detail, is_default, address_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAddress.run(1, "林小满", "13800005621", "阳光社区", "12栋", "2单元602", "东门进入后直行 100 米", 1, 1);
  insertAddress.run(1, "林小满", "13800005621", "阳光社区", "物业服务中心", "", "临时取件地址", 0, 2);

  const insertWallet = db.prepare(`
    INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // 林小满：充值 150，发布 task5 托管 -5
  insertWallet.run(1, null, 4, 150, 150, "微信充值（模拟）", now());
  insertWallet.run(1, 1, 2, -5, 145, "发布任务“晚饭后帮忙带下垃圾”托管", now());
  // 李师傅：充值 130，缴纳接单员保证金 -50（余额 80），发布 task1 托管 -8（余额 72）
  insertWallet.run(2, null, 4, 130, 130, "微信充值（模拟）", now());
  insertWallet.run(2, null, 6, -50, 80, "接单员保证金缴纳", now());
  insertWallet.run(2, null, 2, -8, 72, "发布任务“帮忙取一下丰巢快递”托管", now());
  // 周小北：充值 100，发布 task2 托管 -28、task6 托管 -12
  insertWallet.run(3, null, 4, 100, 100, "微信充值（模拟）", now());
  insertWallet.run(3, null, 2, -28, 72, "发布任务“周末帮忙喂猫和铲屎”托管", now());
  insertWallet.run(3, 2, 2, -12, 60, "发布任务“帮取一份文件并送上门”托管", now());
  // 王老师：充值 60，发布 task3 托管 -10
  insertWallet.run(4, null, 4, 60, 60, "微信充值（模拟）", now());
  insertWallet.run(4, null, 2, -10, 50, "发布任务“帮忙带一份青菜和鸡蛋”托管", now());
  // 陈阿姨：充值 60，发布 task4 托管 -6
  insertWallet.run(5, null, 4, 60, 60, "微信充值（模拟）", now());
  insertWallet.run(5, null, 2, -6, 54, "发布任务“顺路取两杯奶茶”托管", now());

  // 接单员认证演示数据（身份证号与照片均为虚构，仅用于演示）：
  //   李师傅 已认证且保证金在托管中 —— 演示"有资格接单"的状态
  //   周小北 待审核 —— 让管理后台的审核列表开箱即有内容
  //   林小满（演示主账号）刻意保持"未申请"，便于完整演示
  //   申请 → 审核 → 缴纳保证金 → 接单 的全流程
  const insertAcceptor = db.prepare(`
    INSERT INTO acceptor_profiles (
      user_id, real_name, id_card_no, id_card_front, id_card_back, phone, community,
      emergency_contact, status, review_note, reviewed_by, reviewed_at,
      deposit_amount, deposit_status, deposit_paid_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAcceptor.run(
    2,
    "李建国",
    "110101199003150011",
    "/preview/demo-proof.svg",
    "/preview/demo-proof.svg",
    "13900002048",
    "阳光社区",
    "李女士 13900002049",
    3,
    "资料齐全，已通过实名核验",
    1,
    now(),
    50,
    1,
    now(),
    now(),
  );
  insertAcceptor.run(
    3,
    "周敏",
    "320102198511080006",
    "/preview/demo-proof.svg",
    "/preview/demo-proof.svg",
    "13600007712",
    "阳光社区",
    "周先生 13600007713",
    1,
    "",
    null,
    null,
    50,
    0,
    null,
    now(),
  );

  const insertMessage = db.prepare(`
    INSERT INTO messages (user_id, title, content, type, related_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run(2, "订单进度更新", "你接取的“帮取一份文件并送上门”已进入待确认。", 3, 2, 0, now());
  insertMessage.run(1, "社区公告", "阳光社区周末志愿便民服务将在中心广场开展。", 1, null, 0, now());
  insertMessage.run(1, "任务已被接单", "李师傅已接取“晚饭后帮忙带下垃圾”。", 2, 5, 1, now());

  const insertAnnouncement = db.prepare(
    "INSERT INTO announcements (title, content, status) VALUES (?, ?, 1)",
  );
  insertAnnouncement.run("文明跑腿提醒", "请邻里之间保持友好沟通，按约完成服务并及时确认订单。");
  insertAnnouncement.run("周末便民服务", "本周六上午中心广场提供免费磨刀、量血压等便民服务。");

  const insertAdmin = db.prepare(`
    INSERT INTO admins (username, password_hash, real_name, role, status)
    VALUES (?, ?, ?, 2, 1)
  `);
  insertAdmin.run("admin", hashPassword("admin123"), "社区管理员");
  return true;
}

function migrateDemoContactData() {
  const demoPhones = {
    "demo-user": "13800005621",
    "neighbor-li": "13900002048",
    "neighbor-zhou": "13600007712",
    "neighbor-wang": "13700006530",
    "neighbor-chen": "13500001098",
  };
  for (const [openid, phone] of Object.entries(demoPhones)) {
    const user = get("SELECT id, phone FROM users WHERE openid = ?", [openid]);
    if (!user) continue;
    if (String(user.phone || "").includes("*")) {
      run("UPDATE users SET phone = ? WHERE id = ?", [phone, user.id]);
    }
    run("UPDATE addresses SET phone = ? WHERE user_id = ? AND phone LIKE '%*%'", [phone, user.id]);
    run("UPDATE tasks SET contact_phone = ? WHERE publisher_id = ? AND contact_phone LIKE '%*%'", [phone, user.id]);
  }
}

function migrateAddressTypes() {
  const columns = all("PRAGMA table_info(addresses)").map((column) => column.name);
  if (!columns.includes("address_type")) {
    db.exec("ALTER TABLE addresses ADD COLUMN address_type INTEGER DEFAULT 1");
    const users = all("SELECT id FROM users");
    for (const user of users) {
      const addresses = all("SELECT id FROM addresses WHERE user_id = ? ORDER BY id", [user.id]);
      addresses.forEach((address, index) => {
        run("UPDATE addresses SET address_type = ? WHERE id = ?", [index === 0 ? 1 : 2, address.id]);
      });
    }
  }
}

function migrateUserUids() {
  const columns = all("PRAGMA table_info(users)").map((column) => column.name);
  if (!columns.includes("uid")) {
    db.exec("ALTER TABLE users ADD COLUMN uid TEXT");
  }
  const users = all("SELECT id, uid FROM users ORDER BY id");
  for (const user of users) {
    if (!user.uid) {
      run("UPDATE users SET uid = ? WHERE id = ?", [`SQ${100000 + Number(user.id)}`, user.id]);
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid_unique ON users(uid) WHERE uid IS NOT NULL AND uid <> ''");
}

function migrateCategoryAddressModes() {
  const columns = all("PRAGMA table_info(categories)").map((column) => column.name);
  if (!columns.includes("address_mode")) {
    db.exec("ALTER TABLE categories ADD COLUMN address_mode INTEGER DEFAULT 1");
  }
  run("UPDATE categories SET address_mode = 2 WHERE name IN (?, ?)", ["宠物照护", "代扔垃圾"]);
}

function migrateZeroInitialBalances(isFreshSeed = false) {
  const migrationKey = "zero_initial_balance_v1";
  if (get("SELECT value FROM app_settings WHERE key = ?", [migrationKey])) return;
  // 全新库的演示数据已按新口径写入余额与流水，只登记迁移标记，不再清零
  if (isFreshSeed) {
    run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [migrationKey, "done"]);
    return;
  }
  // 安全检查（原审计问题 #19）：原实现无条件执行
  //   UPDATE users SET balance = 0; DELETE FROM wallet_records;
  // 一旦在已有真实交易的库上误触发，会清空全部用户余额与资金流水且不可恢复。
  // 现在只要库中出现任何真实资金痕迹，就只登记标记、绝不执行清零。
  const activity = get(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE pay_status IN (2, 3) OR status IN (3, 4)) AS settled_orders,
      (SELECT COUNT(*) FROM complaints) AS complaints,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM recharge_orders) AS recharges,
      (SELECT COUNT(*) FROM withdraw_orders) AS withdraws
  `);
  const hasRealActivity = Object.values(activity || {}).some((count) => Number(count) > 0);
  if (hasRealActivity) {
    console.warn(
      "[迁移] 跳过 zero_initial_balance_v1：检测到库中已有真实交易记录，为避免清空余额与流水不执行清零。",
      JSON.stringify(activity),
    );
    run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [
      migrationKey,
      `skipped:${JSON.stringify(activity)}`,
    ]);
    return;
  }
  transaction(() => {
    run("UPDATE users SET balance = 0");
    run("DELETE FROM wallet_records");
    run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [migrationKey, "done"]);
  });
}

function migrateOrderFrozenStatus() {
  const columns = all("PRAGMA table_info(orders)").map((column) => column.name);
  if (!columns.includes("frozen_status")) {
    db.exec("ALTER TABLE orders ADD COLUMN frozen_status INTEGER");
  }
}

function migrateDemoBalanceV2() {
  // 给历史库中的演示主账号补充演示余额，保证答辩演示无需先手动充值；
  // 仅当该账号没有任何钱包流水时补，避免对真实操作数据重复入账
  const migrationKey = "demo_balance_restore_v2";
  if (get("SELECT value FROM app_settings WHERE key = ?", [migrationKey])) return;
  transaction(() => {
    const demo = get("SELECT id, balance FROM users WHERE openid = 'demo-user'");
    if (demo) {
      const recordCount = get("SELECT COUNT(*) AS total FROM wallet_records WHERE user_id = ?", [demo.id]).total;
      if (Number(recordCount) === 0) {
        const amount = 150;
        const balance = Number((Number(demo.balance) + amount).toFixed(2));
        run("UPDATE users SET balance = ? WHERE id = ?", [balance, demo.id]);
        run(
          "INSERT INTO wallet_records (user_id, order_id, type, amount, balance, remark) VALUES (?, NULL, 4, ?, ?, ?)",
          [demo.id, amount, balance, "微信充值（模拟）"],
        );
      }
    }
    run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [migrationKey, "done"]);
  });
}

createSchema();
const seeded = seed();
migrateDemoContactData();
migrateAddressTypes();
migrateUserUids();
migrateCategoryAddressModes();
migrateOrderFrozenStatus();
migrateZeroInitialBalances(seeded);
migrateDemoBalanceV2();

module.exports = {
  all,
  db,
  get,
  now,
  parseJson,
  run,
  transaction,
};
