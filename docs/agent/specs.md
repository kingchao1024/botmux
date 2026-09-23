---
title: 规格路由
purpose: 定位行为契约，不复制既有规格长文。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: README.md、README.en.md、docs/design/ 与当前任务请求。
---

# 规格路由

## 事实

- [README.md](../../README.md) 与 [README.en.md](../../README.en.md) 是已支持用户行为的入口说明。
- 详细设计在 [docs/design/](../design/)，实施记录在 [docs/plans/](../plans/) 与 [docs/plan/](../plan/)。
- 当前任务请求定义本次允许范围和验收条件。

## 待验证

- 旧文档可能仍使用过时包管理器命令或描述已替换方案；应以相关源码和可执行检查核实。
- 计划文档不能证明功能已上线；需区分代码就绪、独立验证与生产验证。

## 建议

行为改动引用最小适用真源，并写成可观察验收：输入、预期结果、失败形态和证明它的检查。不要把长设计复制进本 overlay。
