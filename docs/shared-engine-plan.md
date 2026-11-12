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

**2026-11-12 用户决策更新：首版不再维护多个 PyTorch / VLA / WAM 预装镜像。** 仅由管理员配置一个经审查、固定 digest 的基础工作区镜像（Linux + Python + Conda + JupyterLab + Git；不预装 PyTorch、CUDA 用户态运行库、VLA/WAM 或其他大型模型依赖），成员创建自己的容器后在其中按项目需要安装/升级依赖。该基础镜像是维持网页 JupyterLab 即开即用的最低功能基线，而不是多个算法版本的预置环境。**同一 Engine 的基础镜像层只下载一次；成员自行安装的 PyTorch/CUDA 依赖、Conda 环境、缓存和模型仍分别占据各自写入层或持久卷，并可能重复下载。** GPU 使用是容器创建时的独立授权能力，不能因成员安装 CUDA 用户态包就绕过 GPU 设备策略。镜像不自动减半内存，数据卷不得通过删除容器被自动删除。

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
| P1 | 受控 broker：peer UID、可见性、单一管理员基础镜像/卷/容器 CRUD、固定参数、拒绝宿主挂载 | 2–4 | 负面授权单测、跨 UID 单测 |
| P2 | 适配原 `member_docker.py` 的接口（status/profiles/list/create/workspaces/start/stop/logs/pull）；默认只展示一个基础镜像，成员自行安装依赖，保留 Conda | 2–4 | disposable Ubuntu VM A/B，两成员共享镜像且互不可操作 |
| P3 | Jupyter 网关 + WebSocket/会话撤销、GPU CDI、snapshot、备份/恢复、安装/回滚 | 3–6+ | VM 真实浏览器/GPU/存储/撤权验收 |

**最快能供小范围 CPU 测试的量级**：约 4–9 人日（根据 106 后端可复用程度调整）；要完成 GPU、JupyterLab、账户撤权、数据恢复和上线验收：约 8–15+ 人日。上述是工程投入区间，不能理解为当前已经完成或固定交付日期。

## 关键安全规则

1. 成员绝不能访问系统 `/var/run/docker.sock` 或加入 docker 组；不能接受从浏览器发送来的 UID、宿主路径、Docker 参数、任意 shell。
2. broker 由 Unix socket `SO_PEERCRED` 认证真实 UID，并在每一个实例操作/卷操作/快照操作检查归属。持久数据归属必须与容器标签、卷标签一致。不得出现“只验证登录就能操作任意容器”的 HB 问题。
3. 明确容器权限、capabilities、no-new-privileges、PIDs/内存限制、GPU CDI 白名单、默认网络及端口不对外暴露。rootful 容器仍需容器逃逸与文件系统威胁评估。
4. 同一卷只能由一个受控可写运行容器持有；删除容器不删除卷，镜像清理不得误删他人的镜像；账号停用能够撤销已有工作区会话。
5. 先在可抛弃 VM 执行 A/B、Conda、GPU 和 JupyterLab 浏览器真实链路，保留失败证据；最后单独做系统升级/回滚和用户数据恢复演练。

## 暂不开发

动态管理员镜像编辑 UI、模型仓库、网络镜像仓库、统一缓存/数据去重、队列调度、校园网改造。管理员先用 root-owned `/etc/uem/docker-images.json` 配置唯一的基础工作区镜像引用（必须固定 digest），不维护多个算法环境预设。

## 验收看板

- [x] 成员 UI 静态布局迁入；CPU 状态/模板/列表/创建/启动/停止/日志/拉取通过兼容层接线（IMPLEMENTED_SOURCE_ONLY；未验收）
- [ ] 管理员 UI：仅静态页面，原账户管理与校园网业务尚未迁入（NOT_CONNECTED）
- [x] broker 受控动作/UID/卷归属与相关模拟单测：IMPLEMENTED_SOURCE_ONLY，CI PASS（不代表实际安全验收）
- [x] 原成员前端 CPU 业务 JSON 适配：IMPLEMENTED_SOURCE_ONLY；真正的 Cockpit 请求未执行
- [ ] 两用户 CPU A/B 与共用镜像：NOT_RUN
- [ ] GPU CDI：NOT_RUN
- [ ] 浏览器 JupyterLab notebook/kernel/terminal + 撤销：NOT_RUN
- [ ] 备份/还原和升级/回滚：NOT_RUN
- [ ] 生产工作站部署：NOT_RUN

未完成以上门槛，不能将新仓库视作已取代 106-Docker 的正式系统。


## 2026-11-12：基础镜像 + 成员自主安装方案的具体要求

**Why**：当前工作站为 960GB SSD + 8TB HDD（用户提供）；实验室优先上线，暂不投入构建/更新多套 PyTorch、VLA、WAM、大模型训练镜像的维护成本。固态容量不是忽略存储限制的理由。

**镜像策略**：选择一个受审计、固定 digest 的轻量 Jupyter 基础镜像。必须至少有兼容的 `/bin/sh`、Python、Conda（或明确同等包管理器）、JupyterLab，并保证默认非特权用户可安装自己的 Conda 环境。不要在首版预装大型 Torch/CUDA 依赖。管理员配置的是**基础镜像**，不是为项目维护软件栈。没有可靠镜像 digest 时 catalog 继续为空；严禁虚构现成镜像或运行验证结果。

**用户体验**：成员登录后只需填环境名/工作空间，选择“基础科研环境”，设置是否请求 GPU（后端白名单、CUDA 主机 CDI 需验收），点击创建/启动，再在 JupyterLab 里安装项目依赖。首版不开放用户自填任意宿主挂载路径或 Docker Socket。为避免旧 UI 对尚未完成的功能误导，相关操作按状态禁用或明确标记。

**数据与软件**：`/workspace` 是个人持久数据卷；容器停止/启动保留 Conda 的容器可写层，但删除/重建容器会丢失未置于持久卷或未保留到版本镜像中的软件环境。首版必须提供环境记录导出/重新安装说明；容器版本快照、数据备份/恢复是上线前验收门槛，不应把 Docker commit 等同于用户数据备份。

**硬盘布局**：建议 SSD 优先承载共享 Engine 镜像层与热的容器环境，8TB HDD 承载受控的科研数据集、模型权重和检查点，具体取决于真实挂载点、文件系统、性能与备份设计；绝不允许普通成员通过任意 bind mount 直接指定宿主 HDD 目录。要验证可写卷路径隔离、磁盘耗尽处理、SSD/HDD 权限以及大模型训练 I/O。HDD 不是备份，重要数据须另行备份。

**范围变化**：删除“管理员构建 PyTorch GPU、VLA、WAM 多套环境”的首版交付项；保留“基础镜像 + 自助 Conda”。本方案并未取消共享 Engine 授权服务、真实 A/B 隔离、GPU CDI、JupyterLab、备份恢复的验收要求。
