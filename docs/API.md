# REST API 文档

所有接口统一返回：

```json
{
  "code": 200,
  "msg": "success",
  "data": {}
}
```

需要登录的接口使用：

```http
Authorization: Bearer <JWT_TOKEN>
```

## 认证与用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 使用 `wx.login` code 登录，未注册用户自动注册 |
| POST | `/api/admin/login` | 管理员账号密码登录 |
| GET | `/api/config` | 应用配置和公告 |
| GET | `/api/user/profile` | 个人资料与订单统计 |
| PUT | `/api/user/profile` | 修改个人资料 |
| GET | `/api/wallet` | 钱包余额与流水 |

微信登录请求：

```json
{
  "code": "wx.login 返回的临时登录凭证",
  "deviceId": "仅本地模拟登录使用的稳定设备标识"
}
```

后端使用 `code2Session` 换取 `openid`。`openid` 首次出现时创建用户；
已存在时直接登录。响应中的 `is_new_user` 表示本次是否完成自动注册。

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "token": "<JWT_TOKEN>",
    "user": {
      "id": 6,
      "nickname": "微信用户a1b2c3",
      "community": "阳光社区"
    },
    "is_new_user": true,
    "login_mode": "wechat"
  }
}
```

本地未配置微信密钥时，`login_mode` 为 `mock`。浏览器预览仍使用
`code: "demo-user"` 登录演示账号。

## 分类与任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/categories` | 启用分类列表 |
| GET | `/api/tasks` | 任务大厅，支持 `categoryId`、`keyword`、`sort`、分页 |
| POST | `/api/tasks` | 发布任务并托管报酬 |
| GET | `/api/tasks/:id` | 任务详情 |
| POST | `/api/tasks/:id/accept` | 事务接单并生成订单 |
| POST | `/api/tasks/:id/cancel` | 发布者取消任务并退款 |

任务大厅排序值：

```text
newest    最新发布
reward    报酬优先
deadline  时间优先
distance  就近优先（浏览者同社区任务排前，再按期望时间），返回字段 same_community/distance_km
```

任务与订单列表均支持 `page`、`pageSize`（默认 1/20，最大 50），返回 `{ list, total, page, pageSize }`。

## 图片上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | 上传图片，返回可访问 URL |

请求体为 JSON：`{ "dataUrl": "data:image/png;base64,...." }`，仅支持 jpg/png/webp，单张不超过 5MB。
返回 `{ "url": "/uploads/uxxxx.jpg" }`，文件落盘在 `backend/public/uploads/`，由静态服务直接访问。
小程序/浏览器都应先调用本接口拿到 URL，再把 URL 数组提交给发布任务、完成凭证和投诉接口，不要提交本地临时路径或超大 base64。

发布任务示例：

```json
{
  "categoryId": 1,
  "title": "帮忙取一下丰巢快递",
  "description": "两个包裹，取件码接单后发送",
  "pickupAddress": "阳光社区东门丰巢柜",
  "deliveryAddress": "阳光社区12栋2单元",
  "contactName": "林小满",
  "contactPhone": "13800000000",
  "expectTime": "2026-09-12 18:00:00",
  "reward": 8,
  "images": []
}
```

## 订单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/orders?role=published` | 我发布的订单，支持 `status`、`page`、`pageSize`，返回 `{list,total,page,pageSize}` |
| GET | `/api/orders?role=accepted` | 我接取的订单（参数同上） |
| GET | `/api/orders/:id` | 订单详情、评价与投诉 |
| POST | `/api/orders/:id/start` | 接单者开始服务 |
| POST | `/api/orders/:id/finish` | 接单者提交完成凭证（body.images 为上传接口返回的 URL 数组，至少 1 张） |
| POST | `/api/orders/:id/confirm` | 发布者确认完成并结算 |
| POST | `/api/orders/:id/cancel` | 取消订单并退款（已提交完成凭证后不可单方取消，需走投诉） |
| POST | `/api/orders/:id/review` | 订单互评 |

订单状态：

| 值 | 状态 |
| --- | --- |
| 0 | 待支付 |
| 1 | 进行中（已接单） |
| 2 | 待确认（服务中/已提交完成） |
| 3 | 已完成 |
| 4 | 已取消 |
| 5 | 争议冻结（投诉后资金暂停处置，`frozen_status` 记录冻结前状态） |

支付状态：

| 值 | 状态 |
| --- | --- |
| 0 | 未支付 |
| 1 | 已托管 |
| 2 | 已结算 |
| 3 | 已退款 |

## 消息、地址、评价与投诉

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/messages` | 消息列表，支持 `type` |
| POST | `/api/messages/:id/read` | 标记消息已读 |
| POST | `/api/messages/read-all` | 全部消息已读 |
| GET | `/api/addresses` | 地址列表 |
| POST | `/api/addresses` | 新增地址 |
| PUT | `/api/addresses/:id` | 修改地址 |
| DELETE | `/api/addresses/:id` | 删除地址 |
| GET | `/api/reviews` | 收到的评价 |
| GET | `/api/complaints` | 相关投诉记录 |
| POST | `/api/complaints` | 发起投诉；订单资金未结算时自动冻结（订单置 5、任务置 6），冻结期间禁止 start/finish/confirm/cancel |

## 接单员认证与保证金

对外暴露的认证资料一律脱敏：`id_card_no` 从不出现在任何常规响应里，
只返回 `id_card_masked`（保留前 6 位与后 4 位）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/acceptor/profile` | 我的认证状态，返回 `{required_deposit,status,status_text,deposit_status,can_accept,blocked_reason,profile}` |
| POST | `/api/acceptor/apply` | 提交/重新提交实名认证（body：`realName`、`idCardNo`、`phone`、`idCardFront`、`idCardBack`、可选 `emergencyContact`、`community`） |
| POST | `/api/acceptor/deposit` | 缴纳保证金（¥50），从钱包余额扣除并进入平台托管 |
| POST | `/api/acceptor/quit` | 退出接单员并退还保证金（需先结清进行中的订单） |

认证状态 `status` 取值：

```text
0  未申请
1  待审核
2  审核通过，待缴保证金
3  已认证（审核通过 + 保证金托管中），可接单
4  审核未通过（可修改资料后重新提交）
5  已退出
```

保证金状态 `deposit_status` 取值：`0` 未缴纳 / `1` 托管中 / `2` 已退还。

认证校验规则：

- 身份证号：18 位、出生日期真实存在、校验位符合 GB 11643-1999
- 手机号：中国大陆 11 位手机号
- 身份证号全局唯一（同一号码只能绑定一个账号），违反返回 `409`
- 审核中或已认证状态下重复提交返回 `409`

接单门槛：`POST /api/tasks/:id/accept` 在事务前先校验接单资格，
未通过认证或未缴保证金时返回 `403`，`msg` 会说明缺少哪一步；
任务详情与任务列表同时返回 `can_accept` 与 `accept_blocked_reason`，
供前端把"立即接单"替换为"去认证"引导。

## 管理接口

以下接口均要求管理员 Token（每次请求实时校验 `admins` 表状态）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | 运营指标、状态分布、最近订单（含 `acceptorCount`、`pendingAcceptorReviews`） |
| GET | `/api/admin/users` | 用户列表（相关子查询统计，兼容 MySQL） |
| PUT | `/api/admin/users/:id/status` | 禁用或解禁用户 |
| GET | `/api/admin/tasks` | 任务列表 |
| PUT | `/api/admin/tasks/:id/status` | 更新任务状态或下架 |
| GET | `/api/admin/orders` | 订单列表 |
| GET | `/api/admin/categories` | 全部分类 |
| POST | `/api/admin/categories` | 新增分类 |
| PUT | `/api/admin/categories/:id` | 修改分类 |
| GET | `/api/admin/complaints` | 投诉列表（含订单状态与金额） |
| PUT | `/api/admin/complaints/:id` | 处理投诉，body 带 `verdict` 时执行资金裁决 |
| GET | `/api/admin/logs` | 操作审计日志，分页返回 `{list,total,page,pageSize}` |
| GET | `/api/admin/announcements` | 公告列表 |
| POST | `/api/admin/announcements` | 发布公告 |
| GET | `/api/admin/acceptor-profiles` | 接单员认证列表，支持 `status`、`keyword`（姓名/手机号/昵称/UID）、分页；返回脱敏号码与统计 `summary` |
| GET | `/api/admin/acceptor-profiles/:id/id-card` | 查看完整身份证号，每次调用写入 `view_id_card` 审计日志 |
| PUT | `/api/admin/acceptor-profiles/:id/review` | 审核认证：`approved: true` 通过；驳回时须带 `reviewNote` |

接单员审核 / 查看证件 / 认证列表三个接口均要求**超级管理员**（`admins.role >= 2`），
普通管理员调用返回 `403`。


投诉裁决 `verdict` 取值：

```text
refund  投诉成立：托管款退回发布者，订单取消
pay     认定服务完成：托管款结算给接单者，订单完成
reject  驳回投诉：恢复争议冻结前的订单/任务状态
```

请求体同时携带 `handleResult` 处理说明，裁决结果会以站内消息通知双方。不传 `verdict` 时仅记录处理结果。

## 关键并发逻辑

接单接口在事务中读取任务并执行条件更新：

```sql
UPDATE tasks
SET acceptor_id = ?, status = 1, accepted_at = NOW()
WHERE id = ? AND status = 0;
```

只有影响行数为 1 的请求可以创建订单。其他并发请求返回 `409`，避免一单多接。
