# PDD Windows Server 迁移运行清单

目标：将当前 `C:\pdd-native` 原样迁移到 Windows Server。迁移包为可直接读取的目录，
不加密、不打包；浏览器登录态不迁移，目的服务器重新登录。

`CURRENT-READINESS-20260820-ZH.md` 只保留为 2026-08-20 的历史快照，不能作为当前上线结论；当前验收以最终导出后的迁移目录清单、只读运行指标和真实新工单样本为准。

## 服务器前置条件

- Windows Server x64，带桌面体验；使用固定 Windows 账号运行计划任务和店铺浏览器。
- 至少预留 70 GB 可用空间，迁移期间源数据、迁移包、数据库恢复文件会同时存在。
- 准备仅迁移账号可读写的本地目录或 SMB 目录，例如
  `D:\Transfer\pdd-migration-20260821`。
- 使用管理员 PowerShell 执行恢复；登录店铺时必须使用最终运行计划任务的同一 Windows 账号。

## 源机器最终导出

1. 确认没有正在提交的普通工单、退款或钉钉消息。
2. 停止 Worker、API、前端、Notifier、Windows Sync 和 MinIO 计划任务；PostgreSQL 保持运行。
3. 在管理员 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\Export-PddServerMigration.ps1 `
  -DestinationRoot 'D:\Transfer\pdd-migration-20260821' `
  -ConfirmSourceQuiesced
```

`-ConfirmSourceQuiesced` 只能在第 2 步全部写入进程停止并核对后使用。未带该参数的运行只生成 `MIGRATION_PREVIEW.txt`，只能做隔离验证，恢复脚本默认拒绝将其作为最终切换包。

4. 导出完成必须同时存在：

- `MIGRATION_READY.txt`
- `migration-manifest.json`
- `database\postgres-workorders.dump`
- `payload\app\.env.native`
- `payload\app\apps\api\src\worker-event-identity.mjs`
- `payload\app\packages\adapters\src\postgres\index.mjs`
- `payload\app\packages\adapters\src\pdd\order-remark.mjs`
- `payload\app\infra\db\migration-catalog.json`
- `migration-tools\MigrationCatalog.ps1`
- `migration-manifest.json` 中 `migrationCatalog.files` 列出的全部 SQL 文件
- `payload\app\scripts\ordinary-work-order-instance-self-test.mjs`
- `payload\app\scripts\install-bundled-native-extension.ps1`
- `payload\app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json`
- `payload\extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json`
- `external\IIRPA\RPAChromeExtension\manifest.json`
- `external\IIRPA\RPAChromeExtension\II.RPA.NativeMessagingHost.exe`
- `external\PddCoreService\PddCoreService.exe`

5. 验证迁移包：

```powershell
.\Test-PddServerMigration.ps1 -BundleRoot 'D:\Transfer\pdd-migration-20260821'
```

## 目的服务器恢复

1. 确认 `C:\pdd-native` 不存在或为空。
2. 在最终运行账号的管理员 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\Restore-PddServerMigration.ps1 `
  -BundleRoot 'D:\Transfer\pdd-migration-20260821' `
  -InstallRoot 'C:\pdd-native' `
  -Full
```

`-Full` 会恢复 PostgreSQL、按迁移目录清单补齐全部缺失迁移、注册任务、安装 IIRPA Native Host、
`PddCoreService` 和插件 `4.0.1.246`，但不会启动店铺 Worker。

3. 验证恢复结果：

```powershell
.\Test-PddServerMigration.ps1 -InstallRoot 'C:\pdd-native'
```

验收结果必须满足：`ok=true`，`extensionVersion=4.0.1.246`，
`bundledExtensionVersion=4.0.1.246`，`pluginInstallerPinnedVersion=4.0.1.246`，
`extensionManifestHashMatches=true`，`environmentConfigured=true`，
`forceListConfigured=true`，`extensionSettingsConfigured=true`，
`nativeHostRegistered=true`，`nativeHostManifestValid=true`，
`coreServiceValid=true`，`coreServiceRecoveryValid=true`，
`migrationCatalog.valid=true`，且 `missing` 为空。迁移包校验还必须满足
`manifestMigrationCatalog.valid=true` 和 `payloadMigrationCatalog.valid=true`。

## 登录与启动

1. 依次登录所有已启用店铺（当前为五家，后续以前端新增结果为准）。每家必须分别核对 PDD、OMS、TMS 三套身份，不能只以数据库中的登录状态作为依据。
2. 每个店铺浏览器都必须通过运行诊断确认插件 `pcopnibgkbdnlaeagepigbboebdfejmb` 的 `4.0.1.246` 已真实加载；只看到插件文件或 Chrome 策略不算通过。
3. 五家全部登录并确认身份后再启动 Worker：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  C:\pdd-native\app\scripts\start-native-windows.ps1 -StartWorker -NoBrowser
```

4. 只读验收 15 分钟：

- API `3000` 和前端 `4173` 在线；PostgreSQL、MinIO 正常。
- 五家 Worker 均有心跳，浏览器数量稳定，PDD/OMS/TMS 身份与店铺一致。
- 新普通工单可扫描、认领、处理、归档；不存在 `ORDINARY_INSTANCE_MISMATCH` 整批 500 循环。
- 先执行 `node C:\pdd-native\app\scripts\ordinary-latency-gate.mjs --self-test`；有新普通工单样本后必须再以迁移启动时间作为 `--since` 执行真实只读时延门禁。离线测试不能替代这项生产验收。
- 退货退款先扫描再决策，不重放提交结果不明确的历史退款。
- 不发送钉钉测试消息；只观察真实符合条件的新通知。

## 切换前业务基线

- `2026-08-20 23:31` 只读审计时，五家 Worker 均有实时心跳；PDD 为四家已登录、一家停在登录页，TMS 五家已登录，OMS 可在领取工单后自动登录。迁移后要重新实测，不能沿用这条旧状态。
- 拼多多凭证接口返回 `48143 非法请求` 不再直接等同转人工：程序会在不重放外部操作的前提下执行受控重采集、官方上传通道降级和只读结果核对。只有重试耗尽、必需凭证仍不可用，或提交结果不明且继续点击存在重复风险时才转人工；不得无附件强行提交。
- 新普通工单发现到认领 P95 目标为 2 分钟、单笔硬上限 5 分钟；认领到归档 P95 目标为 15 分钟、单笔硬上限 30 分钟。

## 回退边界

恢复脚本拒绝覆盖非空安装目录。源机器在目的服务器验收完成前保持停机但不删除，
若目的服务器验收失败，可重新启动源机器，不使用不完整的目的数据库继续处理业务。
