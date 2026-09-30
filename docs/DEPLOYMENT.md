# 部署说明

## 本地运行

本地演示模式使用 Node.js 内置 SQLite，首次启动会自动创建 `backend/data/sunshine.sqlite` 和演示数据。

```powershell
cd backend
node --no-warnings src/server.js
```

可通过环境变量修改运行参数：

```powershell
$env:PORT = "3000"
$env:JWT_SECRET = "replace-with-a-long-random-secret"
$env:SERVICE_FEE_RATE = "0"
$env:WECHAT_APP_ID = "你的小程序 AppID"
$env:WECHAT_APP_SECRET = "你的小程序 AppSecret"
node --no-warnings src/server.js
```

未配置微信密钥时，本地开发环境自动使用模拟登录。正式环境必须配置
`WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`，否则服务会拒绝启动。小程序
`wx.login` 返回的 code 只能使用一次，不能作为长期用户标识；用户身份以
后端换取的 `openid` 为准。

## 环境变量一览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。默认允许局域网访问（手机真机演示用）；仅本机可访问请设为 `127.0.0.1` |
| `JWT_SECRET` | 自动生成 | 令牌签名密钥。**代码中已不再有任何硬编码默认值**：未配置时首次运行会在 `backend/data/jwt-secret.key` 随机生成并落盘，也可用 `JWT_SECRET_FILE` 指定其他路径。显式配置时长度需 ≥16 位 |
| `SERVICE_FEE_RATE` | `0` | 平台手续费率，`0.05` 表示 5% |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 空 | 微信小程序密钥，必须同时配置 |
| `WECHAT_MOCK_LOGIN` | 自动 | 是否启用模拟登录。`1` 强制开启、`0` 强制关闭；未设置时在"非生产环境且未配置微信密钥"下自动开启 |
| `WECHAT_PAY_MODE` | `mock` | 充值模式。`mock` 为模拟充值，其他值返回 501 |
| `WECHAT_TRANSFER_MODE` | `mock` | 提现模式，同上 |
| `CORS_ORIGINS` | 空 | 允许跨域的来源，逗号分隔。**默认不再下发 `Access-Control-Allow-Origin: *`**；同源请求与本机开发地址（localhost / 127.0.0.1 任意端口）始终放行 |
| `TRUST_PROXY` | 关闭 | 设为 `1` 时才采用 `X-Forwarded-For` 作为限流标识；在 Nginx 等反向代理之后部署时应开启 |
| `ALLOW_INSECURE_DEMO` | 关闭 | 设为 `1` 时解除"演示后门仅限本机/局域网"的限制。**仅供本机调试，公网开启等同于把管理员权限交给所有人** |

## 演示后门与公网安全

模拟登录（`code: "demo-user"`）与模拟充值 / 提现属于演示用的后门能力。修复后
**只对本机与局域网来源开放**：判断依据是 TCP 连接来源地址（回环 + RFC1918 私有网段），
并且只要请求携带任何代理转发头（`X-Forwarded-For`、`X-Real-IP`、`Forwarded` 等）
就一律视为非本机来源。

因此：

- 浏览器预览页、手机真机（走局域网 IP）演示**完全不受影响**；
- 一旦按下方 Nginx 示例部署到公网，模拟登录与模拟充值会**自动失效**，无需额外配置；
- 若确需在公网环境演示，只能显式设置 `ALLOW_INSECURE_DEMO=1`，风险自负。

## 上线前检查清单

- [ ] 配置 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`（模拟登录将自动关闭）
- [ ] 配置 `WECHAT_PAY_MODE` / `WECHAT_TRANSFER_MODE` 为真实支付渠道
- [ ] 视情况显式配置 `JWT_SECRET`，并妥善保管 `backend/data/jwt-secret.key`
- [ ] 按需设置 `CORS_ORIGINS`，不要使用 `*`
- [ ] 反向代理后设置 `TRUST_PROXY=1`，否则限流会对所有用户共用一个计数桶
- [ ] 确认 `HOST`（默认 `0.0.0.0` 会监听全部网卡）
- [ ] 核对 `sqlite` 中 `balance` / `reward` / `amount` 仍为浮点类型，如需正式承载资金建议迁移为整数分存储

## MySQL 8.0

正式环境可使用 `sql/schema.mysql.sql` 创建数据库：

```bash
mysql -u root -p < backend/sql/schema.mysql.sql
```

当前仓库附带完整 MySQL 数据结构，本地演示运行默认使用 SQLite，以便在没有数据库的电脑上直接启动。接入 MySQL 时，应将 `backend/src/db.js` 的同步数据访问实现替换为 `mysql2/promise` 连接池，并保持现有 Service 层接口和事务边界不变。

生产环境需要重点完成以下工作：

1. 配置微信小程序 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`，关闭模拟登录。
2. 设置 `NODE_ENV=production` 并将 `JWT_SECRET` 替换为随机长密钥，全站启用 HTTPS。
3. 将模拟托管支付替换为微信支付下单、支付回调和退款接口。
4. 图片已通过 `POST /api/upload` 落盘到 `public/uploads`；多实例/云部署时替换为对象存储（OSS/COS），保持接口返回 URL 的契约不变。
5. 在 Nginx 后部署 Node.js API，并使用 PM2 管理进程。
6. 接单、结算、退款、投诉裁决等关键操作已写入 `operation_logs` 审计表，可在管理后台「操作日志」查看；接入日志平台时订阅该表即可。

## Nginx 示例

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## PM2

```bash
pm2 start backend/src/server.js --name sunshine-express
pm2 save
pm2 startup
```
