---
title: Agent 文档索引
purpose: 按任务路由到最小必要上下文，不替代现有真源。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: 本索引只路由到源码、既有项目文档和可执行检查。
---

# Agent 文档索引

从这里进入，只打开和当前改动相关的页面。不得整树读取 `docs/agent/`，也不得把这层 overlay 当成对 README 或既有 `docs/` 的重排。

本页也受同一元数据与索引门禁约束：[index.md](index.md)。

| 任务 | 阅读 | 真源 |
| --- | --- | --- |
| 找组件边界、公共路径与影响面 | [architecture.md](architecture.md) | `src/` 与既有架构/设计文档 |
| 确认行为契约或集成要求 | [specs.md](specs.md) | README 与对应 `docs/design/` |
| 规划改动、评审或判断授权边界 | [plans.md](plans.md) | 当前请求、改动代码与 `docs/plans/` |
| 构建、测试、CI、依赖或工具链 | [quality.md](quality.md) | `package.json`、`bun.lock`、workflow、脚本与测试 |
| 进程生命周期、编译态、全局认领或 live 验证 | [reliability.md](reliability.md) | `src/core/self-spawn.ts`、脚本和 runbook |
| setup/onboarding 的 owner 或信任边界 | [security.md](security.md) | `src/setup/owner-identity.ts` 与对应测试 |

## 事实口径

- **事实**：可由列出的真源或已执行检查直接证实。
- **待验证**：当前任务的假设，必须验证后才能据此决策。
- **建议**：默认工程做法，不冒充仓库现状事实。

当前请求与既有文档冲突时，以当前请求约束范围并记录冲突；不要静默改写无关文档。
