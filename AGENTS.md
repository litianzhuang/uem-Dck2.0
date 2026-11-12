# UEM Dck 2.0 — 共享 Docker Engine 开发规则

本仓库是**公开的独立新工程**，目标沿用 106-Docker 的 Cockpit UI/目录/科研流程，评估将每用户 Rootless Engine 替换为**单系统 Engine + 受控授权 broker**。在没有 A/B 验收前不是生产系统。

## 每次任务
1. 阅读本文件和 `docs/shared-engine-plan.md`。
2. 确认当前仓库 main、PR、CI 与目标分支；了解最新 106-Docker AGENTS.md 和相关模块后才移植代码。
3. 只在本仓库的 `codex/*` 分支上修改并发 PR；不得触碰原 106-Docker、HB-Docker 和真实服务器。

## 安全不变量
- Rootful Docker Engine Socket 只允许 root 控制的 broker 访问。普通成员不能加入 docker 组、获得 sudo、访问 rootful Socket，不能直接代理通用 Docker CLI/API。
- 每个请求由 Unix SO_PEERCRED 获取实际 Linux UID；绝不接受浏览器/JSON 提供的 UID 或角色作为授权依据。
- 在每项 inspect/create/start/stop/logs/delete/exec/snapshot/volume 操作前核验 owner。仅有标签不足以抵御外部高权限旁路，必须保护 Socket。
- 禁止任意宿主 bind mounts、privileged、host namespace、任意设备、Docker Socket 透传；限制资源与可用操作。
- Docker 镜像层可共享；容器可写层、Conda 和用户数据卷仍隔离且占用各自空间。
- 公开仓库不提交密码、API 密钥、Cookie、校园网凭据、真实工作站 IP、数据库、用户数据、Notebook、模型权重或真实日志。
- 复用 HB-Docker 的管理思路，不移植其宽权限 SSH Docker 调用/Flask 账户。
- 单元测试 PASS 不等于 VM、真实浏览器、GPU、JupyterLab 或生产验收 PASS。
- 本工程保留原 UI；若旧 JS 还没接入新 broker，则明示 NOT_CONNECTED，不可当作可部署成品。

## 最小范围
一台 Ubuntu 工作站、约 10–15 成员；无 K8s、Slurm、Apptainer、多机调度；先 CPU + 共享镜像 + 私有工作空间，后 GPU CDI、JupyterLab、撤权、备份、回滚。
