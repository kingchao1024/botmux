# Plan 003: 让写任务经过独立验收后才能完成

> **Executor 须知**：逐步执行本 plan。每步先跑验证命令、确认预期结果，再进下一步。触发 STOP 条件后立即停止并回报，不要即兴绕过。完成后更新 `plans/README.md` 中本 plan 的状态。

## 状态

- **执行状态**：DONE（2026-09-25，隔离分支验证通过）

- **优先级**：P1
- **工作量**：M
- **风险**：MED
- **依赖**：`plans/002-guard-project-write-scope-conflicts.md`
- **维度**：正确性 / 测试覆盖 / 架构
- **Planned at**：commit `ba603520d`，2026-09-25 漂移复核

## 为什么值得做

主 Bot 的角色规范要求核对真实产物和独立评审，但普通 project group 目前允许任何已认证的子 Bot 在 `botmux report --status completed` 中直接把 workstream 置为完成。project state 只保存 display-name owners，也没有 reviewer 身份或验收状态，因此“执行与独立验收分离”在普通项目路径上仍是提示词约束。

高保障 task-control 已经证明了正确语义：worker、reviewer 和 acceptor 身份要分离，review 必须晚于交付证据，且不匹配或缺失时 fail closed。本计划不复制其签名文档协议，只在普通 project workstream 上加入轻量、App-ID 绑定的 `in_review → completed` 门禁。

## 现状

- `src/services/project-group-store.ts:8-24` 的状态没有 `in_review`，workstream 也没有 worker/reviewer App ID。
- `src/core/report-session-relay.ts:51-70` 接受子 Bot 自报的 `completed`，但没有 reviewer verdict 字段。
- `src/core/report-session-relay.ts:130-145` 已从可信 session 得到 source `larkAppId`，这是判断谁在报告的可靠身份，不必信任正文。
- `src/services/project-coordinator.ts:346-354` 直接采用 report 携带的 status；`completed` 会直接变成 100%。
- `test/project-group-mode.test.ts:188-194` 明确固化了“单条 completed report 直接完成”的现状。
- `src/services/task-control-plane-store.ts:2860-2911` 的严格路径已经检查 task acceptance、terminal body、independent review、reviewer independence 和事件顺序。
- 当前普通 `botmux report` 已有 status/progress 参数，可以在同一命令上增加轻量 reviewer verdict，不需要新命令。

仓库惯例：状态转换由 service 层校验，不信任自然语言；跨 Bot 身份使用已认证 session 的 `larkAppId`；旧状态需要显式迁移或兼容读取，不能静默变义。

## 目标契约

- 仅 Plan 002 定义的 `access.mode === 'write'` workstream 强制独立验收。
- 新写任务至少包含一个 `workerAppId` 和一个 `reviewerAppId`，两组不相交。
- worker 报告 `--status completed` 只表示交付候选就绪，状态转为 `in_review`，保存交付摘要和时间。
- 只有指定 reviewer 的已认证 session 能提交 `--review-verdict pass|fail`。
- `pass` 将 workstream 置为 `completed`、进度 100；`fail` 将其置为 `blocked` 并保留复验轮次。
- reviewer 不能审核自己的执行结果；未指定 reviewer、错误 reviewer、旧轮次 verdict 或先于交付的 verdict 全部拒绝。
- read-only workstream 维持现有直接 completed 行为。
- project `close` 在仍有 `pending`、`in_progress`、`in_review` 或 `blocked` workstream 时拒绝。本计划不新增绕过参数；行政终止或放弃项目需要另行设计，不能包装成验收通过。

## 会用到的命令

| 用途 | 命令 | 成功时的预期 |
|---|---|---|
| 版本 | `bun --version` | 输出 `1.4.2` |
| Agent 规则 | `bun run check:agent` | exit 0 |
| 项目状态测试 | `bun run test -- test/project-group-mode.test.ts test/project-group-mode-api.test.ts` | 全部通过 |
| 报告路由测试 | `bun run test -- test/dispatch.test.ts test/dispatch-report-binding.test.ts test/dispatch-thread-id.test.ts` | 全部通过 |
| 高保障语义回归 | `bun run test -- test/task-control-plane-store.test.ts test/task-control-plane-route-authority.test.ts` | 全部通过 |
| 构建 | `bun run build` | exit 0 |

## 范围

**In scope**：

- `src/services/project-group-store.ts`
- `src/services/project-coordinator.ts`
- `src/core/report-session-relay.ts`
- `src/core/dispatch.ts` 中 project sync DTO
- `src/cli/dispatch-args.ts` 与 `src/cli.ts` 中 project dispatch/report 参数和 payload 的局部代码
- `src/cli/project-args.ts` 中 `project close` 的现有参数契约测试所需局部代码
- `src/daemon.ts` 中 dispatch registration 和 report relay 的局部代码
- `src/im/lark/project-group-card.ts`
- `src/skills/definitions.ts` 中 orchestrate/report 完成协议
- 对应 focused tests

**Out of scope**：

- 修改 task-control 的签名、SQLite schema、freeze 或生产开关。
- 强制所有只读、文档或普通 handoff 进入 Review。
- 自动选择 reviewer 或按模型评分选择 reviewer。
- 让 reviewer 自动修改实现代码。
- project close 的强制绕过或“放弃项目”新状态。
- 部署、重启或迁移 live project state。
- `src/cli.ts` 现有 `task:new` 未提交改动。

## Git 工作流

- 建议分支：`advisor/003-project-independent-review`。
- commit message 风格：`feat(project): 写任务完成前强制独立验收`。
- 未经用户单独授权，不 commit 或 push。

## 步骤

### Step 1：扩展 workstream 的稳定身份和评审状态

在 `ProjectWorkstream` 增加：

```ts
workerAppIds: string[];
reviewerAppIds: string[];
delivery?: { reportedByAppId: string; content: string; reportedAt: string; round: number };
review?: { reviewerAppId: string; verdict: 'pass' | 'fail'; content: string; reviewedAt: string; round: number };
```

`workerAppIds` 与 `reviewerAppIds` 由 Plan 002 已持久化的 `targetAppIds` 按 `--bot-app <appId:角色>` 分组得出；`owners` 保留作展示字段。为 `ProjectWorkstreamStatus` 增加 `in_review`，并更新进度、排序和卡片显示。兼容读取旧 workstream：缺少新字段时按 legacy 处理，不擅自推断 reviewer。新 project-mode write dispatch 必须填完整身份。

**验证**：先扩展 `test/project-group-mode.test.ts` 写 RED，覆盖旧数据读取、`in_review` 渲染和稳定 App ID 持久化，再实现到 GREEN。

### Step 2：在派单时明确 worker 与 reviewer

复用 `--bot-app <appId:角色>`，在 project-mode write dispatch 中只接受明确的 `worker` / `coder` 与 `reviewer` 角色：

- 至少一个 worker，至少一个 reviewer；
- App ID 不得同时出现在两组；
- 所有人仍必须通过现有 `workerAppIds` 白名单；
- read-only dispatch 可继续使用普通角色标签，不强制 reviewer。

把分组后的稳定 App ID 写入 daemon registration payload 和 project workstream。display name 继续只用于卡片展示。

**验证**：`bun run test -- test/dispatch-args.test.ts test/dispatch.test.ts test/project-group-mode-api.test.ts`，覆盖缺 reviewer、自审、重复 App ID、白名单外 reviewer 和合法 writer/reviewer 组合。

### Step 3：把 worker 的完成声明降为待验收

扩展 report relay decision，把已认证 source session 的 `larkAppId` 作为 `reporterAppId` 送入 project coordinator。对于 write workstream：

- worker 报 `completed` 时，验证它属于 `workerAppIds`；
- 保存 delivery，递增或初始化 round；
- 状态置为 `in_review`，不直接置 100%；
- 非 worker 的交付声明拒绝；
- 同一轮重复报告幂等，内容不同则保留最新候选并让旧 verdict 失效。

read-only workstream 保留历史行为。

**验证**：在 `test/project-group-mode.test.ts` 和 report relay focused tests 中证明 writer 只能推进到 `in_review`，错误身份 fail closed。

### Step 4：增加 reviewer verdict

在 `botmux report` 增加 `--review-verdict pass|fail`，只允许与精确 `--dispatch-root` 或可信 registry route 配合。正文仍必填，作为评审证据摘要。

daemon/report relay 必须以 source session 的 `larkAppId` 校验 reviewer 身份；CLI 参数、正文或 role label 都不是身份凭据。ProjectCoordinator 按 delivery round 校验 verdict：

- `pass`：`completed`、100%；
- `fail`：`blocked`，保存评审摘要和 reviewer；
- 没有本轮 delivery、reviewer 不匹配、reviewer 同时是 worker：拒绝且不改状态。

不要复制 task-control 的 HMAC verdict、doc revision 或数据库表；普通 project group 的可信边界是现有 daemon IPC + session identity + dispatch binding。

**验证**：覆盖 pass、fail、自审、未指定 reviewer、旧 round、重复 verdict 和身份伪造。运行报告路由与项目状态测试。

### Step 5：收紧项目关闭与展示

- 项目卡把 `in_review` 显示为“待验收”，展示 reviewer 和最后 verdict 摘要。
- `project close` 拒绝仍有非终态 workstream，不新增绕过参数。
- 更新 `botmux-orchestrate` 完成协议：writer 交付后必须由指定 reviewer 在原子话题复核，主 Bot 只在 pass 后汇总为完成。

**验证**：`bun run test -- test/project-group-mode.test.ts test/project-group-mode-api.test.ts test/builtin-skills.test.ts`。

### Step 6：做受影响回归

运行本计划全部 focused tests，再运行 `bun run check:agent`、`bun run build`、`git diff --check`。检查 `git diff --stat`，确保没有触碰 task-control 内部协议和范围外文件。

## 测试计划

- write workstream 缺 worker 或 reviewer → 派单失败。
- worker 与 reviewer 相同 → 派单失败。
- writer completed report → `in_review`，不是 completed。
- 指定 reviewer pass → completed 100%。
- 指定 reviewer fail → blocked，保留原因。
- 非指定 reviewer、自然语言“PASS”、旧 round verdict → 状态不变。
- 新 delivery 覆盖旧候选后，旧 verdict 失效。
- read-only workstream 可直接 completed。
- project close 在未验收 write workstream 存在时失败。
- task-control 的独立验收测试保持全绿。

## Done criteria

- [ ] 普通 project-mode 写任务不能由执行者单方面完成。
- [ ] reviewer 身份来自可信 session App ID，且与 worker 集合不相交。
- [ ] `in_review`、pass、fail 和复验轮次在状态存储与卡片中一致。
- [ ] read-only 与非 project dispatch 的兼容行为不变。
- [ ] task-control 协议零改动且相关回归全绿。
- [ ] focused tests、`bun run check:agent`、`bun run build`、`git diff --check` 全部 exit 0。
- [ ] In scope 外没有新增改动，既有未提交改动保留。

## STOP 条件

- Plan 002 未完成或 access contract 与本计划描述不一致。
- 无法从 report relay 的认证 session 获得稳定 source App ID。
- 实现需要信任 report 正文或 role label 来确认 reviewer 身份。
- 需要修改 task-control 的签名或生产状态机才能完成普通项目路径。
- 旧 project state 无法无损兼容读取，需要迁移 live 数据。
- `src/cli.ts` 既有未提交改动与目标代码发生无法安全合并的重叠。

## 维护注记

这是普通 project group 的轻量验收门，不替代 task-control 的生产证据闭环。未来如两条路径合并，应优先抽共享状态语义，不能降低 task-control 已有的签名、revision、时序和独立性校验。
