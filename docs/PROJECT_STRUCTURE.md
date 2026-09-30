# 项目结构说明

## 后端

`backend/src/server.js`

负责 HTTP 路由、参数校验、角色权限、订单状态流转和统一响应。

`backend/src/db.js`

负责本地演示数据库建表、演示数据和事务封装。核心表与 `schema.mysql.sql` 保持一致。

`backend/src/auth.js`

负责 JWT 签发、校验和 scrypt 密码哈希。

`backend/src/wechat.js`

负责微信 `code2Session` 凭证校验、错误转换和本地模拟登录。

## 小程序

页面位于 `miniprogram/pages`：

| 页面 | 作用 |
| --- | --- |
| home | 首页、公告、分类入口、附近任务 |
| tasks | 任务大厅、搜索、筛选、排序 |
| publish | 发布任务与托管确认 |
| orders | 我发布的、我接取的订单 |
| profile | 个人资料、钱包、功能入口 |
| task-detail | 任务详情和接单 |
| order-detail | 状态时间线、开始、完成、确认、取消 |
| messages | 分类消息和已读状态 |
| wallet | 余额和收支流水 |
| addresses | 地址列表和新增/编辑表单 |
| reviews | 提交评价、查看收到评价 |
| complaints | 发起投诉、查看处理结果 |

## 浏览器预览

`backend/public/preview`

与小程序使用相同接口，方便在没有微信开发者工具时验证业务闭环和视觉设计。

## 管理后台

`backend/public/admin`

提供仪表盘、用户、任务、订单、分类、投诉裁决、公告管理和操作审计日志。

## 上传文件目录

`backend/public/uploads`

`POST /api/upload` 上传的图片落盘于此，由后端静态服务直接访问；运行时自动创建，建议加入 `.gitignore`。
