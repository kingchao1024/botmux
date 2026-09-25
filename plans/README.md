# 主 Bot 派单机制改进计划

由 `improve` skill 于 2026-09-24 生成，2026-09-25 漂移复核后将执行基线刷新为 commit `ba603520d`。复核确认三项缺口仍存在。

## 执行顺序与状态

| Plan | 标题 | 优先级 | 工作量 | 依赖 | 状态 |
|---|---|---|---|---|---|
| 001 | 在协作花名册中暴露可信运行态 | P1 | S | 无 | DONE |
| 002 | 为项目派单增加写作用域冲突门禁 | P1 | M | 无 | DONE |
| 003 | 让写任务经过独立验收后才能完成 | P1 | M | 002 | DONE |

状态取值：`TODO`、`IN PROGRESS`、`DONE`、`BLOCKED`、`REJECTED`。

## 依赖说明

- 001 可以独立实施。它只补派单前的运行态证据，不改变队列和接单语义。
- 002 定义普通项目 workstream 的 `access`、稳定参与者身份和写作用域。
- 003 依赖 002，因为只有先区分只读任务与写任务，才能只对写任务强制独立验收，避免让诊断和文档整理也进入无意义的 Review 流程。

## 统一边界

- 保留现有 `botmux dispatch` 接单回执。它已经能证明目标 Bot 的 session 收到了对应 turn，不重复实现 ACK。
- 保留 project group 的 coordinator、worker 白名单、跨群限制、具体标题限制和 talk-only 授权。
- 不把 `capability` 或 `specialties` 当权限凭据；它们仍只用于选择合适角色。
- 不引入新的调度器、队列、数据库或第三方依赖。
- 不改 Workflow v3 和 task-control 的协议；普通 project group 只复用其“身份明确、验收独立、证据先于完成”的语义。
- 不在 worktree 运行 `bun install`。Bun 版本必须为 `1.4.2`；若当前 shell 不是该版本，先按仓库既有工具链修正环境，再执行验证。
- 未经用户单独授权，不 commit、push、merge、release、重启 daemon 或做生产验证。

## 已考虑并拒绝的方案

- 根据模型排行榜派单：拒绝。模型只决定执行能力，不定义职责、授权、工作区或验收独立性。
- 重做 dispatch ACK：拒绝。`waitForExactDispatchAcceptance`、`dispatchInputReceipts` 和 `DispatchLifecycleStatus` 已覆盖接单证明。
- 把普通 project group 全量迁到 task-control：暂不做。task-control 的签名 verdict、document revision 和 freeze 协议适合高保障生产闭环，直接强加给普通协作会显著扩大状态机和运维成本。
- 自动抢占或改派 busy Bot：暂不做。busy 不等于不可接单，现有 queue 仍有价值；第一步只提供可靠证据，由主 Bot决策。
- 只靠角色提示禁止并发写：拒绝作为最终方案。提示词没有原子性，也不能阻止两个并发派单同时通过。

## 全局验证门禁

每份计划完成后先跑该计划的 focused tests。全部计划完成后运行：

```bash
bun run check:agent
bun run test -- test/daemon-heartbeat.test.ts test/bots-list-output.test.ts test/dispatch-args.test.ts test/dispatch.test.ts test/dispatch-lifecycle.test.ts test/project-group-mode.test.ts test/project-group-mode-api.test.ts
bun run build
git diff --check
```

预期：全部 exit 0。`bun run check:agent` 必须先于其他检查；构建不会认领全局 CLI，也不能据此声称 live daemon 已更新。

## 当前工作树提醒

计划生成时 `src/cli.ts` 已有用户未提交改动，集中在 `task:new` 的 project-group 门禁附近。执行任何涉及 `src/cli.ts` 的计划前，必须先运行：

```bash
git diff -- src/cli.ts
```

只在派单相关 symbol 附近追加改动，不得覆盖、移动或格式化现有未提交代码。
