---
title: 架构路由
purpose: 在改行为前定位最窄的源码边界和影响面。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: src/、README.md 与既有 docs/design/ 文档。
---

# 架构路由

## 事实

- daemon、worker、CLI adapter、会话 backend、Lark 集成、setup 和 core 是不同改动面，现行实现以 `src/` 为准。
- 新增或修改 CLI adapter 时，`src/adapters/cli/CLAUDE.md` 是该任务的专用真源。
- 既有设计记录在 [docs/design/](../design/)，产品入口说明在 [README.md](../../README.md)。

## 待验证

- `src/core/`、配置、registry、IM 路由等公共层改动，可能影响多个平台、CLI、backend 和会话类型。
- 看似局部的 adapter 改动也可能经过共享 helper 或 worker 路径；必须追踪调用方后才能声称隔离。

## 建议

在改动证据中写清影响的平台、CLI、backend/会话类型及对应验证方式；只加载覆盖这些路径的源码和设计记录。
