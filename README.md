# 阳光社区邻里快办小程序

面向阳光社区居民的邻里互助跑腿平台。普通用户既可以发布代取快递、买菜代购、宠物照护、代扔垃圾等任务，也可以接单赚取报酬。项目按需求文档实现任务发布、费用托管、并发接单、服务进度、完成结算、互评、消息、投诉和运营管理后台。

## 已实现功能

用户端：

- 微信 `wx.login` 登录、首次登录自动注册、JWT 身份认证和个人资料
- 分类浏览、关键词搜索、报酬/时间/就近排序（同社区优先）
- 发布任务、现场图片上传、期望时间、自定义报酬
- 余额托管、任务大厅、事务防重复接单
- 我发布的/我接取的订单、开始服务、上传完成凭证
- 发布者确认、报酬结算、订单取消与退款
- 双方互评、信用分变动、消息已读
- 钱包流水、地址管理、投诉发起与争议冻结
- 投诉后订单资金冻结、处理结果消息通知

管理端：

- 运营指标、任务状态分布、最近订单
- 用户查询和禁用/解禁
- 任务查询和违规下架
- 订单与资金状态查询
- 服务分类新增、编辑、启停
- 投诉受理、退款/结算/驳回三种资金裁决、结果通知
- 社区公告发布
- 关键操作审计日志（资金、状态、投诉裁决可追溯）

## 技术结构

- 小程序：微信原生 WXML、WXSS、JavaScript
- 后端：Node.js 原生 HTTP 服务、RESTful JSON API
- 本地演示数据库：Node.js 内置 SQLite
- 生产数据库结构：MySQL 8.0，见 `backend/sql/schema.mysql.sql`
- 管理后台：原生 HTML、CSS、JavaScript
- 移动端浏览器预览：同一套真实 API 的可交互页面

本地使用 SQLite 是为了让项目无需安装数据库即可运行和答辩。MySQL 脚本包含与需求文档一致的用户、分类、任务、订单、评价、消息、投诉、地址、钱包和管理员表；正式部署时可将其作为数据库基线。

## 目录

```text
sunshine-community-express/
├─ backend/
│  ├─ src/                    # API、认证、数据库与种子数据
│  ├─ sql/schema.mysql.sql    # MySQL 8.0 建表脚本
│  ├─ public/preview/         # 浏览器移动端预览
│  ├─ public/admin/           # 管理后台
│  └─ data/                   # 本地 SQLite 数据文件
├─ miniprogram/               # 微信开发者工具项目
├─ docs/                      # 接口、部署和项目说明
└─ start.ps1                  # Windows 一键启动脚本
```

## 运行

环境要求：Node.js 22 或更高版本。项目不需要执行 `npm install`。

Windows PowerShell：

```powershell
cd outputs\sunshine-community-express
.\start.ps1
```

或者在 `backend` 目录运行：

```powershell
node --no-warnings src/server.js
```

启动后访问：

- 移动端预览：http://localhost:3000/preview/
- 管理后台：http://localhost:3000/admin/
- 服务状态：http://localhost:3000/api/config

管理后台演示账号：

```text
账号：admin
密码：admin123
```

## 微信开发者工具

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择 `outputs/sunshine-community-express/miniprogram`。
4. AppID 可选择测试号。
5. 在“详情 -> 本地设置”中勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”。
6. 确认后端已运行在 `http://localhost:3000`。

小程序通过 `wx.login` 获取 code 并提交到后端。后端调用微信 `code2Session`
换取 `openid`，首次登录的用户会自动创建账号，之后按 `openid` 复用同一账号并签发 JWT。

本地未配置微信密钥时自动使用模拟登录，便于浏览器预览和界面联调。正式使用微信登录时，在启动后端前配置小程序密钥：

```powershell
$env:WECHAT_APP_ID = "你的小程序 AppID"
$env:WECHAT_APP_SECRET = "你的小程序 AppSecret"
$env:JWT_SECRET = "替换为随机长密钥"
node --no-warnings backend/src/server.js
```

`WECHAT_APP_SECRET` 只能保存在后端。若显式设置 `WECHAT_MOCK_LOGIN=0`，缺少微信配置时服务会拒绝启动。

## 重置演示数据

停止后端后删除 `backend/data/sunshine.sqlite`，再重新启动服务，系统会自动创建表并写入演示数据。

## 文档

- [接口文档](docs/API.md)
- [部署说明](docs/DEPLOYMENT.md)
- [项目结构](docs/PROJECT_STRUCTURE.md)
- [答辩演示流程](docs/DEMO_GUIDE.md)
