# UEM Dck 2.0 — 共享 Docker Engine 研发分支

本仓库用于从 [106-Docker](https://github.com/litianzhuang/106-Docker) 的 Cockpit UI 与科研工作区流程，演进到**服务器端授权的共享 Docker Engine**。借鉴 HB-Docker 的集中容器管理，但不继承其直接向用户授权宿主 Docker 的方式。

> **状态：开发原型，未部署、未完成多用户安全验收；不得直接替换现网。**
>
> 本仓库为公开仓库。禁止提交密码、Token、私钥、校园网凭据、真实工作站地址、用户数据、Notebook、模型及服务器日志。

开发先放在 `codex/shared-engine-mvp` 分支，经过 CI、独立评审、隔离 VM 的 A/B 跨用户测试、GPU/JupyterLab/备份回滚测试后才考虑合并。**现有 106-Docker 仓库及物理服务器均不在本次改动范围内。**

开发细节见 `docs/shared-engine-plan.md`（开发分支）。
