# UEM Dck 2.0 — 共享 Docker Engine 实验项目

本仓库是从 [106-Docker](https://github.com/litianzhuang/106-Docker) 迁移 Cockpit 成员/管理员 UI，并参考 [HB-Docker](https://github.com/litianzhuang/HB-Docker) 的集中式 Docker 管理方式，研发**单台 Ubuntu 科研工作站的安全共享 Docker Engine**。

**当前状态：已迁入 UI 并补上 CPU 容器的初步接口兼容层（状态/模板/列表/创建/启动/停止/日志/镜像拉取），且有 Broker 模拟授权测试。尚未在真实 Cockpit/VM 上验收；终端、JupyterLab、版本快照、管理员账号和校园网功能尚未接入。不得在物理服务器部署。**

## 结构（对齐 106-Docker）

```text
AGENTS.md
README.md
.github/workflows/checks.yml
cockpit/uem_docker/      # 106 的 index/admin HTML、CSS 和 JS，未改版
tools/                   # 新 broker、client、聚焦的单测
deploy/systemd/          # 审核用示例 unit；未安装/未启用
examples/docker-images.json
docs/shared-engine-plan.md
```

## 已提交

- 106 原有 Cockpit 前端布局与路径；成员侧状态、预置模板、列表、创建、启动、停止、日志、预置镜像拉取已连接新兼容层。**仅代码接线，未经过真实 Cockpit/VM 验证。**管理员端及 JupyterLab/终端/快照/校园网后端仍未接通，UI 暂时禁用未实现的成员操作。
- `tools/shared_engine_broker.py`：实验性 root 受控 Unix Socket 服务器，SO_PEERCRED + 当前系统成员组/账号状态校验，模板镜像、容器/卷所有权、固定无特权创建参数；**不提供任意 Docker CLI/Socket 透传**。
- `tools/shared_engine_client.py`：非特权的固定动作客户端。
- `tools/member_docker.py`：保留原 106 前端 JSON 约定的 CPU 容器适配器，未实现功能安全拒绝。
- `tools/test_shared_engine_broker.py` / `tools/test_shared_engine_shim.py`：仅模拟 Docker，覆盖越权拒绝、固定参数、卷保留和原 UI 兼容性。

## 架构原则

同一台服务器的所有成员共用一个 Docker Engine 的镜像层；各自拥有独立容器可写层和命名数据卷。**首版只提供一个带 Python、Conda、JupyterLab 的基础工作区镜像，不预装 PyTorch/VLA/WAM 等算法依赖**；成员在自己的容器内安装升级依赖，不修改公用基础镜像。不同用户的 Conda 包、缓存、模型不会自动去重。停止/启动保留容器软件，删除容器则会丢失未保存在卷或快照里的 Conda 安装。完整约束见迁移计划。

普通成员**不能**访问 rootful Docker Socket、加入 docker 组或获得 sudo。服务端从 Unix Socket 的内核 peer credentials 推断真实 UID，每次操作都验证 owner 和允许的动作。完整风险、开发阶段、投入估计、可验收条件参见 [共享 Engine 开发计划](docs/shared-engine-plan.md)。

## 重要提醒

- 仓库是**公开仓库**，不允许同步旧私有仓库中的服务器地址、登录凭证、校园网信息、科研数据、模型、数据库或现场日志。
- 本项目代码未触碰 `106-Docker`、`HB-Docker` 及任何实体服务器。
- CI 通过只证明静态代码与模拟策略单测；真正上线必须再跑带用户账户和 Docker 的可抛弃 VM、真实浏览器、JupyterLab、GPU、撤销与恢复。
