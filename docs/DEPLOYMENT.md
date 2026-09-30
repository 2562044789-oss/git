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
后端换取的 `openid` 为准。设置 `NODE_ENV=production` 时还必须显式配置
`JWT_SECRET`（随机长密钥），否则服务同样拒绝启动，避免使用代码内置的开发默认值。

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
