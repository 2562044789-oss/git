CREATE DATABASE IF NOT EXISTS sunshine_community
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE sunshine_community;

CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  uid VARCHAR(20) UNIQUE,
  openid VARCHAR(64) UNIQUE,
  nickname VARCHAR(64) NOT NULL,
  avatar_url VARCHAR(255) DEFAULT '',
  phone VARCHAR(20) DEFAULT '',
  community VARCHAR(100) DEFAULT '',
  building VARCHAR(50) DEFAULT '',
  room VARCHAR(50) DEFAULT '',
  credit_score INT DEFAULT 100,
  balance DECIMAL(10, 2) DEFAULT 0,
  role TINYINT DEFAULT 1 COMMENT '1 用户，2 管理员',
  status TINYINT DEFAULT 1 COMMENT '1 正常，0 禁用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE categories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  icon VARCHAR(255) DEFAULT '',
  color VARCHAR(20) DEFAULT '#6DBF8A',
  address_mode TINYINT DEFAULT 1 COMMENT '1 需要取件和送达地址，2 仅服务地址',
  sort INT DEFAULT 0,
  status TINYINT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  publisher_id BIGINT NOT NULL,
  category_id INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  description TEXT,
  pickup_address VARCHAR(255),
  delivery_address VARCHAR(255),
  contact_name VARCHAR(50),
  contact_phone VARCHAR(20),
  expect_time DATETIME,
  reward DECIMAL(10, 2) NOT NULL,
  images TEXT,
  completion_images TEXT,
  status TINYINT DEFAULT 0 COMMENT '0 待接单，1 已接单，2 进行中，3 待确认，4 已完成，5 已取消，6 申诉中',
  acceptor_id BIGINT NULL,
  accepted_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_task_publisher FOREIGN KEY (publisher_id) REFERENCES users(id),
  CONSTRAINT fk_task_category FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_task_acceptor FOREIGN KEY (acceptor_id) REFERENCES users(id),
  INDEX idx_tasks_status (status),
  INDEX idx_tasks_category (category_id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) UNIQUE NOT NULL,
  task_id BIGINT UNIQUE NOT NULL,
  publisher_id BIGINT NOT NULL,
  acceptor_id BIGINT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status TINYINT DEFAULT 1 COMMENT '0 待支付，1 进行中（已接单），2 待确认（服务中/已提交完成），3 已完成，4 已取消，5 争议冻结',
  pay_status TINYINT DEFAULT 1 COMMENT '0 未支付，1 已托管，2 已结算，3 已退款',
  frozen_status TINYINT NULL COMMENT '争议冻结前的订单状态，裁决后清空',
  pay_time DATETIME,
  confirm_time DATETIME,
  cancel_reason VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_order_publisher FOREIGN KEY (publisher_id) REFERENCES users(id),
  CONSTRAINT fk_order_acceptor FOREIGN KEY (acceptor_id) REFERENCES users(id),
  INDEX idx_orders_publisher (publisher_id),
  INDEX idx_orders_acceptor (acceptor_id)
) ENGINE=InnoDB;

CREATE TABLE reviews (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  reviewer_id BIGINT NOT NULL,
  reviewee_id BIGINT NOT NULL,
  rating TINYINT NOT NULL,
  content VARCHAR(500),
  tags VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_review_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  title VARCHAR(100) NOT NULL,
  content VARCHAR(500),
  type TINYINT DEFAULT 1 COMMENT '1 系统，2 任务，3 订单，4 投诉',
  related_id BIGINT,
  is_read TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_message_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_messages_user (user_id, is_read)
) ENGINE=InnoDB;

CREATE TABLE complaints (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  complainant_id BIGINT NOT NULL,
  respondent_id BIGINT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  description TEXT,
  images TEXT,
  status TINYINT DEFAULT 0 COMMENT '0 待处理，1 处理中，2 已处理，3 驳回',
  handle_result VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  handled_at DATETIME,
  CONSTRAINT fk_complaint_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

CREATE TABLE addresses (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  contact_name VARCHAR(50) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  community VARCHAR(100) NOT NULL,
  building VARCHAR(50),
  room VARCHAR(50),
  detail VARCHAR(255),
  address_type TINYINT DEFAULT 1 COMMENT '1 取件/服务地址，2 送达地址',
  is_default TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_address_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE withdraw_orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  withdraw_no VARCHAR(32) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status TINYINT DEFAULT 0 COMMENT '0 处理中，1 已完成，2 已驳回',
  pay_mode VARCHAR(20) DEFAULT 'mock',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  CONSTRAINT fk_withdraw_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE recharge_orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  recharge_no VARCHAR(32) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status TINYINT DEFAULT 0 COMMENT '0 待支付，1 已支付，2 已取消',
  pay_mode VARCHAR(20) DEFAULT 'mock',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  CONSTRAINT fk_recharge_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE app_settings (
  `key` VARCHAR(64) PRIMARY KEY,
  `value` VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE wallet_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  order_id BIGINT,
  type TINYINT NOT NULL COMMENT '1 收入，2 支出，3 退款，4 充值，5 提现',
  amount DECIMAL(10, 2) NOT NULL,
  balance DECIMAL(10, 2) NOT NULL,
  remark VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_wallet_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

CREATE TABLE operation_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  operator_type TINYINT NOT NULL COMMENT '1 用户，2 管理员',
  operator_id BIGINT,
  action VARCHAR(64) NOT NULL COMMENT '操作动作标识',
  target_type VARCHAR(32) DEFAULT '',
  target_id BIGINT,
  detail VARCHAR(500) DEFAULT '',
  ip VARCHAR(64) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_logs_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE admins (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  real_name VARCHAR(50) NOT NULL,
  role TINYINT DEFAULT 1,
  status TINYINT DEFAULT 1,
  last_login_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE announcements (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(100) NOT NULL,
  content VARCHAR(500) NOT NULL,
  status TINYINT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
