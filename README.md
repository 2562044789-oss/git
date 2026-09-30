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
- 接单员实名认证：身份证号 + 手机号 + 证件照片，缴纳保证金后方可接单
- 首页顶部广告轮播：发布跑腿 / 接单员招募 / 资金托管三张，左右滑动或自动切换，圆点指示当前页
  （小程序用原生 `swiper`，浏览器预览用横向 `scroll-snap`；尊重系统"减少动态效果"设置）

管理端：

- 运营指标、任务状态分布、最近订单
- 用户查询和禁用/解禁
- 任务查询和违规下架
- 订单与资金状态查询
- 服务分类新增、编辑、启停
- 投诉受理、退款/结算/驳回三种资金裁决、结果通知
- 社区公告发布
- 接单员认证审核：通过 / 驳回并填写驳回意见，完整身份证号单独查看并留痕
- 关键操作审计日志（资金、状态、投诉裁决、查看证件可追溯）

## 接单员认证与接单门槛

需求约定："只有通过认证的接单员才能接单，未认证用户只能发布任务"。

认证流程共三步，缺任何一步都不能接单：

1. 提交实名资料：真实姓名、身份证号、联系手机号、身份证正反面照片
2. 管理员在后台审核，通过或驳回（驳回需填写意见，用户可修改后重新提交）
3. 审核通过后缴纳接单保证金（¥50），保证金从钱包余额扣除并进入平台托管

约束与保障：

- 身份证号按 GB 11643-1999 校验位数、出生日期与校验位
- 同一身份证号只能绑定一个账号，防止一人多号刷单
- **实名认证只做离线格式校验，不联网核验真伪**：接口验的是"号码格式对不对、有没有抄错"，
  不是"号码是否真属于这个人"。虚构的号码只要校验位算对就能通过并进入"待审核"；
  真伪由管理员在后台人工比对证件照片。这是本项目的既定边界，不是未完成的 TODO ——
  接入公安/运营商核验需要企业资质与付费接口，属部署方的运营决策。
  该边界由 `scripts/verify-acceptor-idcard.js` 用虚构号码实际跑通并钉成断言
- 所有接口返回的身份证号一律脱敏（保留前 6 位与后 4 位）；完整号码只有超级管理员可通过专用接口查看，且每次查看都会写入审计日志
- 接单被拦截时，接口返回 403 并给出具体原因（"缺哪一步"），前端会直接引导用户前往认证页
- 退出接单员需先结清进行中的订单，退出后保证金原路退回钱包余额
- 保证金缴纳与退还在钱包流水中分别记为"接单员保证金缴纳"与"接单员保证金退还"
- 首页轮播的第 2 张是接单员招募，按钮文案跟认证进度走：未申请 / 审核中 / 待缴保证金 / 已认证 /
  未通过 / 已退出六种状态各有对应按钮，避免已认证用户被反复引导去申请；
  保证金金额跟随后端配置（`ACCEPTOR_DEPOSIT`）变化

演示数据中已预置两种状态，方便答辩演示：

```text
李师傅（已认证，保证金托管中，可正常接单）
周小北（已提交资料，等待管理员审核）
林小满（演示登录账号，未提交认证：可发布任务，接单会被拦截）
```

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
│  ├─ public/preview/         # 浏览器移动端预览（含接单员认证面板）
│  ├─ public/admin/           # 管理后台（含接单员认证审核）
│  └─ data/                   # 本地 SQLite 数据文件
├─ miniprogram/               # 微信开发者工具项目（接单员认证页 pages/acceptor）
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

## 自检脚本

`backend` 目录下的脚本都无需额外依赖，直接运行即可：

```powershell
node --no-warnings --test                           # 接口回归测试（30 个用例）
node --no-warnings scripts/verify-acceptor-ad.js    # 接单员广告的按钮文案、认证入口与已删除项回归（28 项）
node --no-warnings scripts/verify-acceptor-idcard.js # 身份证校验强度：验了什么、没验什么（10 项）
node --no-warnings scripts/verify-hero-carousel.js  # 首页广告轮播的数据与结构（37 项）
node --no-warnings scripts/screenshot.js --url http://127.0.0.1:3000/preview/ --out shot.png --slide 2
```

`verify-acceptor-ad.js` / `verify-hero-carousel.js` 会把前端的文案函数从源码里切出来真求值，
测的是上线代码本身；`verify-acceptor-idcard.js` 用临时库起一个后端，
**用虚构的身份证号证明认证只做离线格式校验、不联网核验真伪**（详见下节）。
`screenshot.js` 调用本机 Edge/Chrome 的 headless 模式截图（不下载浏览器），
`--slide N` 表示截图前先把首页轮播切到第 N 张，可用 `EDGE_PATH` 指定浏览器路径。

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
