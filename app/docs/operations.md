# 运行与发布手册

## 服务边界

- PostgreSQL 是工单、检查点、分类、命令和审计的唯一看板状态源。
- Redis 用于队列基础设施；店铺业务互斥由 PostgreSQL 租约保证。
- MinIO 保存截图和诊断对象，数据库保存 SHA-256、对象 Key、MIME 和生命周期状态。
- 动态调度器按已启用店铺创建 Worker；每家分别固定 `WORKER_SHOP_ID`、进程 ID、心跳和 Browser Profile，店铺数量不写死。
- Windows JSON、归档和图片通过只读同步器幂等导入；同步器不删除或改写源文件。

## 日常检查

```powershell
npm test
npm run owner:self-test
npm audit --omit=dev --audit-level=moderate
docker compose --env-file .env.staging -f infra/docker/docker-compose.staging.yml ps
```

API `/healthz` 必须显示 PostgreSQL、MinIO、所有者鉴权和 Worker Token 均已配置。同步心跳的 `backlog_count` 必须为 0，所有已启用店铺的 `last_success_at` 必须新鲜。

## 外部操作保护

Docker live Worker 在 TMS 创建、PDD 备注和每次 PDD 提交前向父进程申请 `external_effects` 记录。相同店铺和幂等键只能保留一条记录：

- `succeeded`：禁止重复执行。
- `reserved` 或 `unknown`：停止自动重试并人工核对平台结果。
- `failed` 且请求哈希一致：允许受控重试。

平台响应不明确时记录 `unknown`，不能猜测失败并重新提交。

## 权限与修订

普通内部访问者只读。`system-owner` 可修改自动化/转人工分类、添加数据修订、处理转人工事项和创建流程指令。所有修改必须提供原因并写入审计；原始 Worker 事件不可编辑。前端不持有数据库账号，也不能直连 PostgreSQL。

## 钉钉通知

普通工单仅在持久业务证据确认仓库超范围、未知场景、图片最终上传失败或新增普通工单进入人工暂停时进入机器人 Outbox。普通工单群消息在工单类型下方列出可直接复制的 OMS 发货仓库，并在存在与当前普通工单实例精确绑定的 `tms-evidence` 时嵌入真实 TMS 凭证原图及原图链接；`DINGTALK_EVIDENCE_PUBLIC_BASE_URL` 必须是群成员可访问的公网 HTTPS 地址，本机或内网地址不会作为图片地址发送。退货退款只推送 `manual-review`、`page-error` 和 `verification-required`，正常等待买家物流不推送；其联系人由 `DINGTALK_RETURN_REFUND_RECIPIENTS` Secret 单独配置。每天北京时间 18:30 前生成可编辑草稿，不自动发送；今日和历史处理单量直接复用普通登录者运营台的 `autoSuccess` 口径。系统所有者在前端审阅或编辑两项数据后手动发送到钉钉群，已发送草稿禁止再次发送。群消息只显示“Agent 工单执行汇报”标题、“今日Agent已处理单量”和“Agent历史总处理单量”两项，不附带日期、所有者、编辑人或手动发送信息。普通工单以运营台中的业务单元计数；退货退款等待物流和订单不存在的跳过记录不计入处理单量。

登录、验证码、等待物流、限流、网络错误和页面崩溃只显示在看板。聊天中出现过的 Webhook 和签名必须先在钉钉后台轮换，再写入服务器 Secret 文件。默认 `DINGTALK_NOTIFICATIONS_ENABLED=false`，完成 dry-run 和收件人核对前不得开启。

## 发布到 Ubuntu

1. 在 CI 或受控构建机运行测试、依赖审计和镜像构建。
2. 为 API、Web、Worker 镜像记录不可变摘要并推送私有仓库。
3. 服务器备份 PostgreSQL、MinIO 和 Redis，更新 Compose 使用的镜像摘要。
4. 先更新 API/Web，再逐店更新 Worker；每次只停止一个店铺。
5. 检查健康、登录、租约、幂等记录和看板事件后再继续下一店。
6. 应用异常时回滚镜像版本，不回滚 PostgreSQL 到 JSON。
