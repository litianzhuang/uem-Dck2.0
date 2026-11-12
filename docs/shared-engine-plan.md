# 共享 Engine 最小影响迁移方案 — 2026-11-12

## 基线与范围

- 目标：`litianzhuang/uem-Dck2.0`（**公开、初始空仓库**）；仅在新分支开发。
- 原产品/UI 基线：`litianzhuang/106-Docker` main `5b384ca2a67a49512a0797eacc1ee9ef92a5f88c`。保留 `cockpit/uem_docker/`、PAM/Cockpit 登录、成员/管理员页面、环境列表和 JupyterLab 使用体验。
- 中央 Docker 参考：`litianzhuang/HB-Docker` main `b0ba6d1a72f617685572ae5ec809ba05e197847e`。仅借鉴集中 Docker/镜像命令；它使用 SSH 在目标服务器执行 Docker CLI，部分操作缺少 owner 校验，**不能直接当多用户安全后端**。
- 本仓库不导入 HB 全部 13k+ 文件、Flask/数据库认证、SSH 凭证平台、课程/AI 辅助模块，也不更改已部署的 106-Docker。

## 目标架构

```text
Cockpit/PAM 现有成员登录（页面保持 106 原样）
    -> member_docker.py 兼容接口（UID 来自操作系统）
       -> Unix socket + SO_PEERCRED
          -> 仅 root 可访问 Docker Socket 的受控 broker
             -> 固定动作 + 逐次所有权校验 + 资源/挂载/镜像策略
                -> 单一 rootful Docker Engine
                   -> 所有人共享只读镜像层
                   -> 每人独立容器可写层 + 独立命名卷
```

管理员预置 CPU/PyTorch GPU/VLA 常用镜像，成员选择并创建容器，使用自身容器内的 Conda/venv 升级环境。**镜像层只需在同一 Engine 下载一次，但每人的 Conda 变更、缓存、模型和可写层仍单独占用空间。** 不自动减半内存或共享容器内动态修改。

## 目录规划（与原 106 对齐）

```text
AGENTS.md
README.md
.github/workflows/checks.yml
cockpit/uem_docker/{index.html,admin.html,app.css,app.js,admin.js,navigation.js,manifest.json}
tools/{member_docker.py,shared_engine_broker.py,shared_engine_client.py,test_shared_engine_*.py}
deploy/systemd/uem-shared-engine-broker.service
examples/docker-images.json
docs/shared-engine-plan.md
```

原 `tools/jupyter_*.py`、`tools/admin_members.py`、`deploy/install-ubuntu.py` 后续按需要迁移和重审，**不能为了凑目录复制旧 Rootless 安装器**。目录可能先有 UI 而未有新 API，严禁直接安装部署。

## 最快的开发顺序（参考投入，非按时交付承诺）

| 阶段 | 开发目标 | 人日估算 | 必须通过 |
| --- | --- | ---: | --- |
| P0 | 复制经过脱敏检查的 106 UI；保留页面契约；建立 CI | 0.5–1 | 静态检查 |
| P1 | 受控 broker：peer UID、可见性、镜像/卷/容器 CRUD、固定参数、拒绝宿主挂载 | 2–4 | 负面授权单测、跨 UID 单测 |
| P2 | 适配原 `member_docker.py` 的接口（status/profiles/list/create/workspaces/start/stop/logs/pull）；保留存储、环境选择及 Conda | 2–4 | disposable Ubuntu VM A/B，两成员共享镜像且互不可操作 |
| P3 | Jupyter 网关 + WebSocket/会话撤销、GPU CDI、snapshot、备份/恢复、安装/回滚 | 3–6+ | VM 真实浏览器/GPU/存储/撤权验收 |

**最快能供小范围 CPU 测试的量级**：约 4–9 人日（根据 106 后端可复用程度调整）；要完成 GPU、JupyterLab、账户撤权、数据恢复和上线验收：约 8–15+ 人日。上述是工程投入区间，不能理解为当前已经完成或固定交付日期。

## 关键安全规则

1. 成员绝不能访问系统 `/var/run/docker.sock` 或加入 docker 组；不能接受从浏览器发送来的 UID、宿主路径、Docker 参数、任意 shell。
2. broker 由 Unix socket `SO_PEERCRED` 认证真实 UID，并在每一个实例操作/卷操作/快照操作检查归属。持久数据归属必须与容器标签、卷标签一致。不得出现“只验证登录就能操作任意容器”的 HB 问题。
3. 明确容器权限、capabilities、no-new-privileges、PIDs/内存限制、GPU CDI 白名单、默认网络及端口不对外暴露。rootful 容器仍需容器逃逸与文件系统威胁评估。
4. 同一卷只能由一个受控可写运行容器持有；删除容器不删除卷，镜像清理不得误删他人的镜像；账号停用能够撤销已有工作区会话。
5. 先在可抛弃 VM 执行 A/B、Conda、GPU 和 JupyterLab 浏览器真实链路，保留失败证据；最后单独做系统升级/回滚和用户数据恢复演练。

## 暂不开发

动态管理员镜像编辑 UI、模型仓库、网络镜像仓库、统一缓存/数据去重、队列调度、校园网改造。管理员先用 root-owned `/etc/uem/docker-images.json` 配置预置模板。

## 验收看板

- [ ] 成员/管理员 UI：保留静态页面，尚未接入新后端（NOT_CONNECTED）
- [ ] broker 授权与容器 CRUD：开发中（NOT_ACCEPTED）
- [ ] 原前端业务适配：NOT_RUN
- [ ] 两用户 CPU A/B 与共用镜像：NOT_RUN
- [ ] GPU CDI：NOT_RUN
- [ ] 浏览器 JupyterLab notebook/kernel/terminal + 撤销：NOT_RUN
- [ ] 备份/还原和升级/回滚：NOT_RUN
- [ ] 生产工作站部署：NOT_RUN

未完成以上门槛，不能将新仓库视作已取代 106-Docker 的正式系统。
