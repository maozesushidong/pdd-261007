# 架构与迁移

现有 `workflow.mjs` 是兼容 Worker。新平台的 Domain、Application、Contracts 和 Adapters 已建立，后续按 PDD、OMS、TMS 适配器逐步替换旧单体逻辑。

PostgreSQL 是业务状态源，Redis 用于队列和店铺锁，MinIO/S3 保存截图与诊断文件。迁移期间不允许新旧进程同时写入同一订单。

