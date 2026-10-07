# pdd-261007：2026-10-07 Windows 运行快照

本仓库来自当时运行中的 `D:\pdd-native`。仓库所有者明确要求保留真实业务数据、账号密码、代理配置、服务密钥和部署配置，并确认以公开仓库上传。配置文件保持原值，数据分片仅压缩，没有加密。

## 包含内容

- `app/`：当前应用代码、前端构建产物、数据库迁移、店铺配置、`.env.native`、`.env.staging`、`secrets/`。
- 根目录的启动、停止、计划任务与守护脚本；`cloud-gateway/`、`https/`、`caddy/`、`extensions/`：当前部署配置及所需密钥、证书、插件资源。
- `snapshot/`：PostgreSQL 一致性快照、数据库角色和权限、非图片业务文件，以及与源机器相同的 Node、PostgreSQL、MinIO、Chrome 和 npm 依赖。
- `snapshot/manifest.json`：导出时间、归档大小、每个分片的 SHA-256、数据排除说明。
- `snapshot/windows-tasks/`：源机 9 个 PDD 计划任务的定义，包括守护、同步、每日汇总、证书和公网隧道任务。

## 按要求排除的内容

不含浏览器 Profile、Cookie、Storage State、Local Storage、Session Storage、已登录会话令牌；不含工单截图、聊天图片、上传附件图片。保留程序图标和插件资源。数据库和业务 JSON 内夹带的登录态字段也已清理，长期运行配置中的账号、密码、代理凭据、API 密钥保持原值。

历史备份、调试临时目录、运行锁、PID、实时心跳和实时数据库物理文件不作为恢复源。数据库中的历史业务记录保留。图片记录引用可能仍存在，但相应图片文件按要求不恢复。

## 恢复到新机器

要求 Windows x64、PowerShell、Git，以及可用的 `tar.exe`。建议使用与源机相同的 `D:\pdd-native` 路径。必须使用一个没有现存数据库的新目录。

```powershell
git clone https://github.com/maozesushidong/pdd-261007.git D:\pdd-native
cd D:\pdd-native
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Pdd.ps1
```

归档按 45 MiB 分片直接存储在 Git 中，不依赖 Git LFS，不需要另外下载 Release。恢复脚本会校验每个分片及完整归档的 SHA-256，再解包运行环境、还原数据库、恢复非图片对象，并逐表核对备份中的记录数。无需重新执行 `npm install` 或升级依赖。

也可以从已克隆的仓库恢复到其他空目录：

```powershell
.\Restore-Pdd.ps1 -InstallRoot D:\pdd-native-restored
```

路径迁移会重写源机 `D:\pdd-native` 的绝对路径。源机公网地址、隧道远端、网关权限、Windows 用户权限和网络可达性仍取决于目标机器，不能仅靠复制文件复现。

仅验证归档，不恢复数据库：

```powershell
.\Restore-Pdd.ps1 -VerifyOnly
```

脚本会在目标目录 `.restore-work/` 保存重组归档和恢复日志；需要为仓库、重组归档及解压后的业务数据留出足够空间。数据库恢复出现错误时查看 `.restore-work/database-restore.log`。完成后生成 `RESTORE-REPORT.json`。

## 启动

先以管理员身份执行以下命令，将计划任务绑定到当前 Windows 账号：

```powershell
.\Install-PddTasks.ps1
.\start-local.ps1 -SkipWorker -NoBrowser
```

通过项目的店铺登录流程重新登录每家店铺，再启用自动化任务：

```powershell
.\start-local-worker.ps1 -NoBrowser
```

默认服务端口与源机一致：PostgreSQL `5433`、API `3000`、普通前端 `5145`、管理入口 `5148`、MinIO `9000/9001`。管理端根路径可能返回伪装的 404，这是当前配置的行为。

`Restore-Pdd.ps1` 本身不会启动业务 Worker、发送钉钉消息或执行工单操作。恢复验证只启动独立的临时数据库和对象存储，验证结束后停止。

当前 `load-local-env.ps1` 强制项目浏览器直连；原有代理账号和配置仍保留在原文件中。恢复保持当前覆盖逻辑，不会擅自切换代理。

## 快照边界

数据库通过 PostgreSQL 的单一只读事务快照导出；文件在导出期间逐一复制，当前运行服务未停止。数据库截止时间和文件导出完成时间见清单。快照之后原系统新增或修改的数据不会自动同步到该仓库。

恢复结果保留业务记录和运行配置；店铺登录态和历史业务图片按照要求排除，因此恢复后需要重新登录，旧图片不能查看。程序图标、插件、编译产物和依赖与本次导出版本保持一致。
