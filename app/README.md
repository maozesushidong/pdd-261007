# 电商工单自动化系统

这是一个支持多店铺、多工单场景的 PDD/OMS/TMS 自动化平台。系统包含 Playwright 业务 Worker、PostgreSQL 状态与审计、Redis、MinIO、Fastify API、React 运营看板、验证定位以及 Windows/Linux Docker 部署配置。

## 本地运行

```bash
npm test
npm run api
npm run web
```

- API：`http://127.0.0.1:3000`
- 看板：`http://127.0.0.1:4173`

## Docker

```powershell
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml --profile visual up -d
```

默认看板与基础设施会启动，业务 Worker 必须经过逐店切换后显式启用。动态调度器为每个已启用店铺分配独立店铺目录、进程身份和浏览器 Profile；店铺数量来自数据库和前端配置，不在代码中固定。

第三方账号和密码只能通过 Secret 文件注入；不要写入代码、规则、日志或前端接口。PDD 使用人工扫码登录，OMS/TMS 优先自动登录。验证定位只提供人工辅助，不绕过验证码或滑块。完整操作见 [docs/operations.md](docs/operations.md) 和 [docs/migration.md](docs/migration.md)。
