# 私有仓库本地部署说明

本仓库对应 Windows 本机正在运行的 PDD/OMS/TMS 工单自动化版本。代码、数据库迁移、原生 Windows 启停脚本、当前验证码插件以及实际运行配置一起交付。

## 安全边界

本私有仓库按所有者要求包含真实运行密钥：

- `.env.native`
- `.env.staging`
- `secrets/staging/*`

这些文件包含数据库、MinIO、PDD、OMS、TMS、钉钉和管理端凭据。仓库不得改为公开，不得 Fork 到个人公开空间，也不得把文件内容粘贴到工单、聊天或日志。成员离开项目后，应轮换全部凭据并移除其仓库权限。

浏览器 Profile、Cookie、登录 Storage State、实时 PostgreSQL 数据、工单截图和日志不进入 Git。它们与机器和账号安全状态绑定，复制到另一台电脑既不可靠，也会扩大登录态泄露范围。

## 目录要求

原生脚本以项目父目录作为安装根目录。请把仓库克隆到以下固定位置：

```powershell
C:\pdd-native\app
```

最终目录应至少包含：

```text
C:\pdd-native\app       项目仓库
C:\pdd-native\runtime   Node、PostgreSQL、MinIO、Chrome for Testing
C:\pdd-native\data      数据库、浏览器 Profile 和业务运行数据
C:\pdd-native\logs      本机日志
C:\pdd-native\extensions
```

首次安装运行环境请按以下两份文档执行：

- `docs/Windows_Server_原生迁移与零基础部署手册.docx`
- `docs/Windows_Server_部署完成与零基础运维手册.docx`

## 首次安装

以管理员身份打开 PowerShell，在 `C:\pdd-native\app` 下执行：

```powershell
npm ci
npx playwright install chromium
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-bundled-native-extension.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-windows-tasks.ps1
```

验证码插件的仓库副本位于：

```text
vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246
```

安装脚本会将其复制到固定扩展目录，配置 Chrome for Testing，并更新 `.env.native` 中的插件路径和插件 ID。

## 首次登录

每台电脑都必须分别建立五个店铺的 PDD Browser Profile。双击：

```text
OPEN-PDD-LOGIN-WINDOWS.cmd
```

依次确认五个店铺的 PDD 登录身份。PDD 登录成功后由本机 Profile 保持登录态；OMS 和 TMS 使用仓库内 Secret 自动登录。不要从其他电脑复制 Browser Profile。

## 启动与停止

启动后台服务和五个店铺 Worker，不自动打开前端看板：

```text
START-PDD-NATIVE.cmd
```

前端看板：<http://127.0.0.1:4173/>

停止全部本地服务和自动化浏览器：

```text
STOP-PDD-NATIVE.cmd
```

## 交付验收

开始真实处理前执行：

```powershell
npm test
npm run web:build
```

随后检查：

1. `http://127.0.0.1:3000/healthz` 返回健康。
2. 看板显示五家店铺 Worker 在线。
3. 五个浏览器都加载固定 ID 的验证码插件。
4. PDD 店铺身份与 `shops.config.json` 一致。
5. OMS 使用 `shared` 模式，TMS 能进入客服登记页面。
6. 先用一张受控工单验证 PDD -> OMS -> TMS -> PDD 全链路，再开启持续扫描。
