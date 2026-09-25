# Plan 002: 为项目派单增加写作用域冲突门禁

> **Executor 须知**：逐步执行本 plan。每步先跑验证命令、确认预期结果，再进下一步。触发 STOP 条件后立即停止并回报，不要即兴绕过。完成后更新 `plans/README.md` 中本 plan 的状态。

## 状态

- **执行状态**：DONE（2026-09-25，隔离分支验证通过）

- **优先级**：P1
- **工作量**：M
- **风险**：MED
- **依赖**：无
- **维度**：正确性 / 安全 / 架构
- **Planned at**：commit `ba603520d`，2026-09-25 漂移复核

## 为什么值得做

当前角色规范要求并行开发者只改分配给自己的模块，但这是提示词约束。普通 project workstream 只保存标题、说明、负责人和状态，没有稳定的 App ID、访问模式或写路径；`dispatch` 也无法在派发前判断两个活跃任务是否会写同一目录。现实配置中多个开发 Bot 可以指向同一个默认工作目录，因此冲突不是假设问题。

本计划给 project-mode 的新派单增加显式 `read-only` / `write-scope` 契约，并在发送任何飞书种子消息前完成原子 reservation。只读任务不互斥；写作用域发生祖先、后代或同路径重叠时拒绝派单。

## 现状

- `src/cli/dispatch-args.ts:3-42` 没有访问模式或写作用域参数。
- 当前 `cmdDispatch` 公开参数只有目标、简报、repo、standby、into 等，没有访问模式或写作用域。
- `src/services/project-group-store.ts:11-24` 的 `ProjectWorkstream` 没有 target App ID、工作区或 write scope。
- `src/services/project-coordinator.ts:309-345` 注册 workstream 时不做资源冲突判断。
- `src/daemon.ts` 的 `DISPATCH_REPORT_REGISTER_ROUTE` 仍先发送 seed，再注册 dispatch 和投影 project；若这时才发现冲突，会留下孤儿话题。
- `/root/.botmux/data/team-roles/cli_aa1f3189edf99bb4.md:8` 等角色文件仅以文字要求并行修改不覆盖他人改动。
- `src/services/project-group-store.ts:98-118` 已使用文件锁保护 project state 的 read-modify-write，应复用这个原子边界。

仓库惯例：危险状态必须 fail closed；持久写使用文件锁和原子替换；身份使用稳定 `larkAppId`，不使用可改 display name；不靠提示词代替安全门禁。

## 目标契约

仅对 project mode 的“新建 workstream”强制：

- 必须且只能选择 `--read-only` 或至少一个 `--write-scope <absolute-path>`。
- `--write-scope` 可重复，表示本 workstream 可能写入的最小现存目录集合。第一版不支持单文件或尚未创建的路径，宁可保守扩大目录范围。
- 路径必须绝对且为现存目录；通过 `realpath` 归一化，解析失败时拒绝，不猜测。
- 任意两个非终态 workstream 的 write scope 只要同路径，或一方是另一方祖先，就视为冲突。
- `read-only` 与任何 workstream 不冲突。
- `completed` 和 `failed` 释放 claim；`pending`、`in_progress`、`blocked`、后续新增的 `in_review` 都占用 claim。
- `--into` 只能沿用原 workstream 的 access contract，不能借追加消息改写或扩大 scope。
- 非 project mode 保持现有兼容行为。

## 会用到的命令

| 用途 | 命令 | 成功时的预期 |
|---|---|---|
| 版本 | `bun --version` | 输出 `1.4.2` |
| Agent 规则 | `bun run check:agent` | exit 0 |
| 参数测试 | `bun run test -- test/dispatch-args.test.ts` | 全部通过 |
| 项目状态测试 | `bun run test -- test/project-group-mode.test.ts test/project-group-mode-api.test.ts` | 全部通过 |
| 派单回归 | `bun run test -- test/dispatch.test.ts test/dispatch-thread-id.test.ts test/dispatch-lifecycle.test.ts` | 全部通过 |
| 构建 | `bun run build` | exit 0 |

## 范围

**In scope**：

- `src/cli/dispatch-args.ts`
- `src/cli.ts` 中 `cmdDispatch` 和 daemon registration payload 的局部代码
- `src/daemon.ts` 中 `DISPATCH_REPORT_REGISTER_ROUTE`
- `src/services/project-group-store.ts`
- `src/services/project-coordinator.ts`
- `src/services/group-collaboration-mode-store.ts` 的 project dispatch policy 类型与校验
- `src/core/dispatch.ts` / `src/core/dispatch-lifecycle.ts` 中对应 DTO
- `src/skills/definitions.ts` 的 dispatch/orchestrate 使用说明
- `test/dispatch-args.test.ts`、`test/dispatch.test.ts`、`test/dispatch-thread-id.test.ts`、`test/project-group-mode.test.ts`、`test/project-group-mode-api.test.ts`

**Out of scope**：

- OS 级文件锁、Git 自动 merge、自动分支或 worktree 创建。
- 根据自然语言猜测修改文件。
- 允许 `capability`、Bot 名称或模型名称决定写权限。
- 改动非 project mode 的 legacy dispatch 行为。
- 修改真实 Bot 配置或重启服务。
- `src/cli.ts` 现有 `task:new` 未提交改动。

## Git 工作流

- 建议分支：`advisor/002-project-write-scope-claims`。
- commit message 风格：`feat(project): 阻止重叠写作用域并发派单`。
- 未经用户单独授权，不 commit 或 push。

## 步骤

### Step 1：先定义纯 access contract 和重叠算法

新增 `src/core/dispatch-write-scope.ts`，集中定义：

```ts
type DispatchAccess =
  | { mode: 'read_only' }
  | { mode: 'write'; scopes: string[] };

function normalizeWriteScopes(raw: string[]): string[];
function writeScopesOverlap(left: string[], right: string[]): boolean;
```

规范化须使用平台路径语义和 `realpath`，只接受现存目录，去重并删除被父目录完全覆盖的子项。例如 `/repo/src` 与 `/repo/src/api` 归并为 `/repo/src`。比较必须基于路径 segment，不能用裸字符串前缀让 `/repo/a` 错撞 `/repo/ab`。

**验证**：新增 `test/dispatch-write-scope.test.ts`，先观察 RED，再覆盖同路径、父子路径、近似前缀、不相交、重复 scope、相对路径、`..`、不存在路径、非目录路径与 symlink 边界。

### Step 2：扩展 CLI 参数但不改非项目兼容性

在 `DispatchArgs` 增加：

- `readOnly: boolean`，对应 `--read-only`；
- `writeScopes: string[]`，对应可重复的 `--write-scope`。

参数层拒绝两者同时出现。project policy 层对新建 workstream 要求二选一；`--into` 不允许携带任一参数。非 project mode 未提供参数时保持历史行为。更新 `botmux dispatch --help` 和内置 skill 文案。

**验证**：`bun run test -- test/dispatch-args.test.ts test/builtin-skills.test.ts`。预期新增参数、互斥规则和 project-only 兼容边界都有断言。

### Step 3：在 project state 中持久化稳定参与者和 access contract

扩展 `ProjectWorkstream`：

```ts
targetAppIds: string[];
access: DispatchAccess;
```

同时在 `ProjectGroupState` 增加只供派单事务使用的短期 reservation 集合：

```ts
dispatchReservations?: Array<{
  reservationId: string;
  targetAppIds: string[];
  access: DispatchAccess;
  createdAt: string;
  expiresAt: string;
}>;
```

reservation 在 seed 创建前还没有 `dispatchRoot`，因此不能伪装成普通 workstream。新增三段式动作：

1. `reserve_dispatch`：由 coordinator daemon 生成不可预测 `reservationId`，在 `mutateProjectGroup` 的文件锁内检查所有非终态 workstream 的 write scope，冲突则返回稳定错误 `project_write_scope_conflict`，不创建任何消息。
2. `commit_dispatch`：seed 和 registry 写入成功后，将 reservation 原子转换为带 `dispatchRoot`、title、purpose、targetAppIds、owners 和 access 的普通 workstream，并删除 reservation。
3. `abort_dispatch`：seed 或 registry 失败时释放 reservation，且必须校验 coordinator 身份与 reservationId。

reservation 设短 TTL，并在每次 reserve 时清理过期项，避免进程崩溃永久占锁。TTL 只用于未 commit 的 reservation；已 commit claim 由 workstream 终态释放。

不要把 Lark 网络 I/O 放进项目文件锁。

**验证**：在 `test/project-group-mode.test.ts` 覆盖原子竞争、重叠拒绝、不相交通过、read-only 通过、终态释放、过期 reservation 回收和错误 reservationId 拒绝。

### Step 4：把 reservation 接到 daemon 派单顺序

调整 `DISPATCH_REPORT_REGISTER_ROUTE`：

1. 完成现有身份、群、worker 白名单和标题校验。
2. project mode 下先 reserve。
3. reserve 成功后才发送 seed。
4. registry 写入成功后 commit reservation。
5. seed 或 registry 失败时 abort reservation。
6. commit 失败时返回失败，并明确记录 seed 已创建的 residual；不要继续发送 kickoff。

CLI 把 access contract 送入 daemon registration payload；输出回执增加 `access`，但保留现有字段和成功语义。

**验证**：扩展 `test/dispatch-thread-id.test.ts` 或新增 daemon route focused test，证明冲突在 seed send 前被拒绝，失败路径释放 reservation，成功路径才允许 kickoff。

### Step 5：做受影响回归

依次运行参数测试、项目状态测试、派单回归、`bun run check:agent`、`bun run build`、`git diff --check`。检查 `git diff --stat`，确保无范围外修改。

## 测试计划

- project mode 新任务未声明 access → fail closed。
- `--read-only` 与 `--write-scope` 同时出现 → 参数错误。
- 两个并发 reserve 请求声明 `/repo/src` 和 `/repo/src/api` → 恰好一个成功。
- `/repo/a` 与 `/repo/ab` → 不冲突。
- readonly 与 write → 均可存在。
- write workstream completed/failed 后，新 claim 可获取。
- blocked workstream 仍持有 claim。
- `--into` 不能改 access。
- 非 project mode 的旧命令保持原行为。
- registry、acceptance receipt、project card 的现有测试不回归。

## Done criteria

- [ ] project-mode 新 workstream 必须有机器可判的 access contract。
- [ ] 重叠 write scope 在发送 seed 之前被拒绝。
- [ ] 并发 reserve 不会双赢，崩溃不会留下永久 reservation。
- [ ] target 身份持久化为 App ID，display name 只用于展示。
- [ ] 非 project mode 保持兼容。
- [ ] focused tests、相关回归、`bun run check:agent`、`bun run build`、`git diff --check` 全部 exit 0。
- [ ] In scope 外没有新增改动，既有未提交改动保留。

## STOP 条件

- 实现必须持有项目文件锁跨越 Lark 网络请求。
- 路径规范化需要跟随不可信目录下的任意 symlink，且没有现成安全 helper 可复用。
- 为了支持普通非 project dispatch，必须扩大兼容面。
- 发现同一项目存在多个合法 coordinator daemon 并发写入，当前 reservation 设计无法给出单写者保证。
- `src/cli.ts` 既有未提交改动与派单区发生无法安全合并的重叠。

## 维护注记

write scope 是协调契约，不是 OS sandbox。它阻止主控发出已知冲突任务，但不能约束 Bot 实际越界写文件。真正的强隔离仍应使用独立 worktree 或 sandbox。后续如要自动创建 worktree，应另立计划，不要塞进本变更。
