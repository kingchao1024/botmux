---
title: 质量与工具链
purpose: 路由构建、测试、依赖、CI 和提交规范到可执行真源。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: package.json、bun.lock、.github/workflows/、scripts/ 与 test/。
---

# 质量与工具链

## 工具链事实

- `package.json` 将包管理器固定为 Bun `1.4.2`，`.github/workflows/` 使用相同编译版本。
- `trustedDependencies` 刻意只含 `electron`、`node-pty`；未经单独评审不得删除、扩展或替换。
- canonical 安装命令是 `bun install --frozen-lockfile`。绝不在 worktree 执行 `bun install`：共享或软链 `node_modules` 可能被删除，或被另一 checkout 静默覆盖版本。
- 分支改动 `package.json` 或 lockfile 时，只能在 worktree 外解决依赖，例如 canonical checkout 或 CI；不能用 worktree install 规避。
- `install-diagnostics.ts` 与 `maintenance.ts` 中的 `pnpm-global` 表示终端用户安装方式，不是本仓库工具链，不得据此改回 pnpm。
- `bun run build` 是仓库构建门槛；任务相关测试命令以 `package.json` 为准。

## 测试规则

- 测试中 spawn TypeScript 子进程必须使用 `test/helpers/ts-runner.ts`，不能写 `spawn(process.execPath, ['--import', 'tsx', ...])`。
- 子进程片段需要 import 仓库模块时，使用 `spawnTsEvalWithRepoImports`；普通 `spawnTsEval` 在 Node 下会出现模块找不到。

## 待验证

- 不得假定通用 Node 或包管理器命令适用；先检查对应 `package.json` 脚本和 workflow job。
- 聚焦测试通过不等于公共路径安全；按 [架构路由](architecture.md) 补足影响面验证。

## 建议

先跑最窄的有效检查，再跑受影响测试和构建。本 overlay 先跑 `bun run check:agent`，再跑 `bun run build`；记录实际命令和结果，不得把失败或跳过写成通过。

## PR 与提交规范

- PR 标题和 commit message 使用 `type(scope): 中文描述`；type、scope 保持英文，描述使用中文。
- PR 中文说明改了什么、为什么、影响面和实际验证；不得只写“应该没问题”。
- UI 改动（飞书卡片、dashboard、web 终端）附截图示意。
- 公开 git 历史不得出现飞书真人名，也不得出现机器人协作花名或内部评审编排；验证只写客观操作与结果。
