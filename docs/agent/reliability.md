---
title: 运行可靠性与发版边界
purpose: 保留 daemon、编译态、全局认领、live 验证和发版的安全边界。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: src/core/self-spawn.ts、scripts/claim-botmux-bin.mjs、scripts/smoke-bun-binary.mjs、package.json、workflow 与相关 runbook。
---

# 运行可靠性与发版边界

## daemon 与编译态事实

- 不得用裸 `node` 启 daemon，必须使用 `bun run daemon:*`。会话存储依赖 SQLite 引擎；错误 PATH 可能解析到不支持 `node:sqlite` 的 Node，造成 daemon 子进程全崩。
- supervisor 本身不依赖 SQLite，可能仍打印“已重启”而 daemon 实际全部失败；preflight 会在拆掉既有 fleet 前检查引擎能力。遇到这类形态先看实际日志，必要时使用 `BOTMUX_INTERPRETER=<abs>`。
- 编译版模块位于 Bun 虚拟文件系统。子进程入口必须用 `src/core/self-spawn.ts` 中的 `isStandaloneBinary()`、`resolveEntrySpawn` 或 `spawnWorker`；不得把 `__dirname` 或 `dist/` 拼出的路径交给子进程。
- `scripts/smoke-bun-binary.mjs` 使用空 `bots.json`，daemon 会在更早处拒绝 `BOTMUX_BOT_INDEX=0`；因此 smoke 通过不覆盖 daemon 深层路径。

## 全局认领与 live 验证事实

- `bun run build` 不会认领全局 `botmux` wrapper。`bun run use:here` 才认领，`bun run switch:here` 才是 build 加认领。
- 需要人工 live 验证时，必须使用 `bun run switch:here && bun run daemon:restart`；不要依赖裸 `botmux restart`，否则可能重启到 PATH 中其它安装。
- 上述操作会让全部 bot 使用当前 checkout。测试或合并结束后应切回 canonical checkout，避免 review worktree 删除后全局 shim 失效。

## 待验证

- build 或 smoke 结果不一定覆盖 daemon 路径、目标平台或真实 IM 投递；明确记录缺失边界。
- 全局认领和 daemon 重启会改变他人的执行路径；执行前确认授权和当前 checkout。

## 发版边界

- 只有明确授权才能创建并 push `v*` annotated tag；日常 commit/push 不构成发版授权。
- 不得手动修改 `package.json` 的 `version`；tag message 使用中文，CI 从 tag 提取版本并生成 Release 内容。
- `latest` 正式版只能来自 master；灰度使用 `-canary.N`、`-beta.N` 或 `-rc.N`，不能污染 latest。

## 建议

分别报告本地检查、全局认领、daemon 重启和 live 手测。后三者都必须先获得明确授权，不能从“请 build/test”中推断。
