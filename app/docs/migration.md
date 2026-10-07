# Windows Docker 到 Linux 迁移运行手册

## 安全边界

- 旧 Worker 与 PostgreSQL Worker 不得同时处理同一店铺。
- 只有三个店铺锁均不存在或对应 PID 已退出，才允许制作迁移快照。
- `auth`、`browser-profile`、`locks` 永不进入迁移 manifest、PostgreSQL 或 MinIO。
- Windows Chromium Profile 不复制到 Linux。Linux 首次部署必须通过 noVNC 重新登录。
- 迁移脚本默认 dry-run。真实写入必须同时传 `--apply`，并设置与 dry-run 输出完全一致的 `MIGRATION_APPLY_CONFIRM`。

## 1. 校验和快照

先确认没有订单处于提交、上传或创建阶段，再优雅停止旧 Worker：

```powershell
npm run migration:validate
npm run migration:manifest
npm run migration:backup
```

默认备份只包含可迁移数据。只有需要制作本机浏览器回滚副本时才使用：

```powershell
node scripts/backup-legacy-data.mjs --include-local-session-backup
```

该选项会把 `auth` 和 `browser-profile` 放进快照的 `local-rollback-only`，其中包含 Cookie/登录态，只能留在本机受限目录，不得上传服务器、对象存储或 Git。

## 2. Windows staging 基础设施

复制 `.env.staging.example` 为 `.env.staging`，替换占位值。不要提交 `.env.staging`。

```powershell
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml config
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml up -d postgres redis minio minio-init api web
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml ps
```

不要启用 `worker` profile。staging 默认以 `DATA_BACKEND=legacy-json` 只读展示旧数据。

## 3. 数据迁移

先执行 dry-run，保存输出中的 `manifestHash`：

```powershell
node scripts/migrate-legacy-json.mjs
```

只有基础设施健康且 dry-run 数量正确时才执行：

```powershell
$env:MIGRATION_APPLY_CONFIRM='<dry-run manifestHash>'
node scripts/migrate-legacy-json.mjs --apply
node scripts/verify-migration.mjs --verify-live
```

迁移使用确定性 UUID、唯一约束和 source hash，可以重复执行。原 JSON 不修改、不删除。截图对象已存在时必须同时匹配大小和 SHA-256，否则迁移停止而不是覆盖。

## 4. API 切换

迁移前：

```text
DATA_BACKEND=legacy-json
```

迁移及对账通过后：

```text
DATA_BACKEND=postgres
```

切换 API 不等于启用 Worker。`WORKER_EXECUTION_ENABLED` 仍保持 `false`。

## 5. Worker 灰度

灰度前先执行只读基础设施检查。该命令只对 MinIO 写入并立即删除随机探针，不访问 PDD/OMS/TMS：

```powershell
docker run --rm --network pdd-workflow-staging_default --env-file .env.staging \
  pdd-workflow-staging-api node apps/worker/src/preflight.mjs
```

检查必须返回 PostgreSQL 店铺数、Redis set/get/delete 和 MinIO write/delete 全部成功，且 `active_leases=0`。

### Docker 浏览器可视化

staging/production 提供 `visual` profile。它启动 Xvfb、Openbox、VNC 和 noVNC，但不会启动业务 Worker：

```powershell
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml --profile visual up -d display vnc novnc
```

noVNC 只绑定 `127.0.0.1:6080`，通过 SSH 隧道访问 `http://127.0.0.1:6080/vnc.html?resize=scale&quality=9&compression=0`。镜像默认使用 `quality=9`、`compression=0`，优先保证验证码、表格和文字清晰度；如果网络较慢，可在 noVNC 设置中降低质量。Worker 启动后使用同一 X11 socket，浏览器窗口会显示在该页面；不要将 5900 或 6080 绑定到公网。x11vnc 在 Compose 内网监听 `0.0.0.0:5900`，不能使用容器内 `-localhost`，否则 noVNC 所在的独立容器无法连接 VNC 后端。

逐店启用，不允许同店双跑。启用任何店铺前必须满足：

1. 旧 Windows Worker 已停止且锁已释放。
2. PostgreSQL、Redis、MinIO 和 API 健康。
3. 迁移对账通过。
4. PDD/TMS 外部操作幂等键可查询。
5. 当前店铺不处于 TMS 创建、附件上传、PDD 备注或 PDD 提交阶段。

当前 PostgreSQL Worker 支持三种运行边界：

- `WORKER_EXECUTION_ENABLED=false`：进程仅保持 disabled heartbeat，不访问队列。
- `WORKER_EXECUTION_ENABLED=true` 且 `WORKER_RUN_MODE=shadow`：连接 PostgreSQL/Redis/MinIO，定时读取队列、租约并写 heartbeat，但绝不领取或修改工单；适合 staging 常驻观察。
- `WORKER_EXECUTION_ENABLED=true` 且 `WORKER_RUN_MODE=live`：必须额外设置 `WORKER_LIVE_APPROVED=true`。每店使用 PostgreSQL 租约，TMS 创建、PDD 备注和 PDD 提交由 `external_effects` 幂等闸门保护；不满足条件时立即停止，不回退为无保护执行。

当前 staging 使用 `shadow` 模式，因此 Docker 中能看到健康 Worker，但不会自动处理历史归档订单。

### PDD 自动发现与单店灰度

真实 `live` Worker 不要求人工输入订单号。店铺队列为空时，Worker 按
`PDD_DISCOVERY_INTERVAL_MS`（默认 90 秒）启动当前店铺的 PDD 待处理列表发现流程，精确匹配配置的工单类型，读取订单号后以
`shop_id + external_order_number + work_order_type` 唯一键写入 PostgreSQL `queued` 队列；重复发现只复用已有记录，不重复入队。
随后 Worker 使用 PostgreSQL 租约领取该工单，再调用 Playwright 完成 PDD -> OMS -> TMS -> PDD 全流程。
发现模式也会先恢复 OMS 订单管理和 TMS 客服登记两个常驻标签，再进入 PDD 列表；因此 PDD 验证或登录暂停时，三个系统标签仍已创建并保持在业务页。
每张工单结束后 Worker 先确认 `full-business-flow-complete`/归档状态并释放 PostgreSQL 租约，再通过 IPC 优雅关闭该次 Playwright 子进程。下一轮继续自动发现并复用同一店铺 Browser Profile，不再处理一单后永久等待。`WORKER_MAX_ORDERS=0` 表示连续运行；大于 0 只用于受控测试。

`scripts/prepare-gray-run.mjs --order=...` 仅保留给诊断演练，生产不要求人工输入订单号。没有新待处理工单时不会把已归档订单重新排队。

### 逐店切换

Windows Supervisor 先升级到当前代码并重新启动一次。之后使用持久化控制文件只停目标店铺：

```powershell
npm run worker:local-control -- --shop=panapopo-healthcare --enabled=false
```

确认 `.codex/shops/<shopId>/locks/workflow.lock` 已释放，执行一次最终同步，再启动对应 Docker 服务。首次启动在 noVNC 中扫码登录 PDD，OMS/TMS 使用 Secret 自动登录。确认 Docker 心跳、九个基础系统标签、自动发现和 PostgreSQL 租约后，再切下一店。

回滚时先停止该店 Docker Worker并确认租约释放，再恢复本地：

```powershell
npm run worker:local-control -- --shop=panapopo-healthcare --enabled=true
```

禁止在 Docker Worker 尚未停止时恢复 Windows Worker。

## 6. 数据卷备份

每天至少保存：

- PostgreSQL：`pg_dump --format=custom`，并验证 `pg_restore --list`。
- MinIO：使用固定版本 `mc mirror --overwrite --remove` 镜像到独立磁盘或远端 bucket。
- Redis：保留 AOF/RDB 用于队列恢复；业务事实以 PostgreSQL 为准。

每周执行恢复演练。备份目录与生产卷分离，备份文件加密并限制权限。浏览器 Profile 只在对应服务器本机做受限备份。

## 7. Linux 正式切换

Ubuntu 24.04 使用 `infra/docker/docker-compose.production.yml`。API/Web 默认只绑定 `127.0.0.1`；noVNC 也必须只绑定本机，通过 SSH 隧道访问。生产首次写入前可退回 Windows 旧 Worker；生产已经写入 PostgreSQL 后只能回滚应用镜像，不能回退 JSON 为写入源。

Windows staging 与 Ubuntu production 使用同一 `Dockerfile.worker`。构建后应按镜像摘要发布到镜像仓库，服务器只拉取该摘要，不能在服务器上临时修改容器源码。
