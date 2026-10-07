# 本地与服务器对齐复查

检查日期：2026-09-23（北京时间）

后续用户要求仅放慢 PDD 并暂停夜间处理，相关本地改动和当前部署状态见同目录 PDD_PACING_NOTES.md。本报告下方的一致性结论对应此前对齐检查时点。

## 对比范围与结果

- 服务器：121.196.220.219；本地应用：D:\pdd-native\app。
- 通过 SSH 获取最新文件清单，比较 apps、packages、config、scripts、infra、patches、bootstrap 共 746 个部署文件；745 个完全一致，唯一不同的是 apps/web/src/server.mjs 中的本地前端路径适配。
- 另比对了 workflow.mjs、workflow-runtime.mjs、run-shops.mjs 等根目录脚本以及 package.json、package-lock.json、pnpm-lock.yaml，均与服务器一致。
- 管理前端和普通前端构建产物、共享模块、数据库迁移脚本一致。
- Node v22.23.2；pg 8.22.0、playwright 1.62.0、fastify 5.10.0、react 19.2.8、AWS S3 SDK 3.1098.0、vite 8.1.5，两端一致。
- 环境文件差异为本地数据库连接、代理配置和显式的所有者凭据文件路径；凭据文件映射由服务器同一份环境加载脚本处理。

## 已修正

1. 运行中的本地 API 原为 Windows Docker / legacy-json，而 Worker 使用 PostgreSQL。现统一加载服务器的原生环境，API 已使用 Windows Native / postgres，并识别动态 Worker。
2. 本地启动入口已使用 apps/worker/src/main.mjs，与服务器的动态 Worker 入口一致。
3. MinIO 在 API 前启动，并从应用的 S3 凭据文件读取启动凭据。
4. 普通前端的 /public/assets 路径和 /public-api 路径在本地直接访问时缺少服务器 Caddy 的去前缀处理，导致白屏或接口返回 HTML。现已补齐等效路径处理，保留普通端接口白名单。
5. 启动脚本增加 API 健康检查、端口等待和新鲜 Worker 心跳检查；重复启动不会重复拉起进程。

修改文件：

- D:\pdd-native\load-local-env.ps1
- D:\pdd-native\start-local.ps1
- D:\pdd-native\app\apps\web\src\server.mjs

## 验证

- API /healthz：200，PostgreSQL 正常。
- 20 个启用店铺，20 个 Worker 在线；这是进程/心跳在线状态，不表示各平台登录已完成。
- 管理端登录接口：200；认证、设置、运行控制读取、容量、统计、工单、验证记录 7 个接口均为 200。
- 普通前端已在浏览器实际加载，显示运营总览、店铺和场景；JS、CSS 资源类型正确，接口返回 JSON。
- 普通端访问所有者认证和设置接口仍为 404，隔离规则保持有效。
- PostgreSQL 有 305 条迁移记录，当前代码目录没有缺失的迁移记录。
- 使用应用 S3 凭据执行 HeadBucket 成功。
- 再次运行启动脚本前后 Node 进程均为 45 个，没有新增重复进程。
- PowerShell 脚本解析和 Node 服务语法检查通过。

## 保留的差异与待处理事项

- 按要求保留本地数据和直连代理策略；本地 PostgreSQL 使用 5433 端口。
- 浏览器资料、部分截图未随原迁移包迁入；登录、短信验证仍按店铺逐一人工处理。检查时 18 个启用店铺 PDD 未确认登录，19 个 OMS 未确认登录，状态会随人工操作变化。
- 服务器普通前端会统一显示“已登录/运行正常”，这来自原有展示逻辑，不能用于排查真实登录故障。本地保留相同行为；真实状态以管理端为准。
- 本次验证了配置、启动、页面、接口和依赖；没有执行真实退款、提交工单等业务操作，因此不能据此断言所有业务分支已完成端到端验证。
- 后续可改善进程意外退出恢复、开机启动和日志轮转；目前优先维持与服务器相同的业务行为。

## 本地入口

- 管理端：http://127.0.0.1:4173/owner/
- 普通端：http://127.0.0.1/public/
- 统一启动：D:\pdd-native\start-local.ps1（支持 -NoBrowser 参数）
