# Plan 001: 在协作花名册中暴露可信运行态

> **Executor 须知**：逐步执行本 plan。每步先跑验证命令、确认预期结果，再进下一步。触发 STOP 条件后立即停止并回报，不要即兴绕过。完成后更新 `plans/README.md` 中本 plan 的状态。

## 状态

- **执行状态**：DONE（2026-09-25，隔离分支验证通过）

- **优先级**：P1
- **工作量**：S
- **风险**：LOW
- **依赖**：无
- **维度**：正确性 / DX
- **Planned at**：commit `ba603520d`，2026-09-25 漂移复核

## 为什么值得做

主 Bot 选人前会读取 `botmux bots list`，但当前输出只能说明目标是否在群里、能否寻址和是否具备 transport，无法说明目标 daemon 是否在线或正在忙。`runtime.stale` 甚至固定为 `unknown`。仓库已经每 15 秒写入按 App ID 区分的 busy heartbeat，也有严格的 daemon descriptor 新鲜度校验；缺口只是这些证据没有汇入协作花名册。

落地后，主 Bot 能在派单前区分 `idle`、`busy`、`offline` 和 `unknown`。这只是决策信息：busy Bot 仍可接收排队任务，不新增自动抢占、自动改派或硬拒绝。

## 现状

- `src/core/daemon-heartbeat.ts:17-25` 定义了 `{ larkAppId, busyCount, at }` 和 60 秒新鲜窗口。
- `src/core/daemon-heartbeat.ts:41-56` 只提供 fleet 级 `anyDaemonBusyTo`，没有按 Bot 读取状态的公开函数。
- `src/utils/daemon-discovery.ts:38-62` 的 `OnlineDaemonInfo` 带 `larkAppId` 与 `lastHeartbeat`；`listOnlineDaemons` 已负责过滤无效或过期 descriptor。
- `src/cli/bots-list-output.ts:43-62` 已有 `collaboration.runtime`，但只暴露 transport、deployment、stale。
- `src/cli/bots-list-output.ts:201-206` 把 `runtime.stale` 无条件写成 `unknown`。
- `src/cli.ts:14607-14624` 的 `collaborationFactsFor` 目前只读取 BotConfig，不读取 daemon 或 busy heartbeat。
- `test/daemon-heartbeat.test.ts:15-60` 和 `test/bots-list-output.test.ts:142-193` 是应复用的测试风格。

仓库惯例：将纯判定放入独立 core/helper，通过依赖注入和临时目录测试；CLI 只负责组合数据。未知证据必须保留为 `unknown`，不能猜成在线或离线。

## 会用到的命令

| 用途 | 命令 | 成功时的预期 |
|---|---|---|
| 版本 | `bun --version` | 输出 `1.4.2` |
| Agent 规则 | `bun run check:agent` | exit 0 |
| 聚焦测试 | `bun run test -- test/daemon-heartbeat.test.ts test/bots-list-output.test.ts` | 全部通过 |
| 相关回归 | `bun run test -- test/daemon-discovery.test.ts test/bots-list-output.test.ts test/builtin-skills.test.ts` | 全部通过 |
| 构建 | `bun run build` | exit 0 |

## 范围

**In scope**：

- `src/core/daemon-heartbeat.ts`
- `src/cli/bots-list-output.ts`
- `src/cli.ts` 中 `cmdBots` / `collaborationFactsFor` 的局部代码
- `src/skills/definitions.ts` 中 `botmux-bots` 的字段说明
- `test/daemon-heartbeat.test.ts`
- `test/bots-list-output.test.ts`
- 必要时新增一个只覆盖 `cmdBots` 组合逻辑的 focused test

**Out of scope**：

- 自动负载均衡、自动改派、自动取消、优先级队列。
- 修改 heartbeat 写入频率或 daemon 生命周期。
- 修改 `dispatch` 的 ACK、队列和接单等待逻辑。
- Dashboard UI。
- `src/cli.ts` 中现有 `task:new` 未提交改动。

## Git 工作流

- 建议分支：`advisor/001-dispatch-runtime-health`。
- commit message 风格：`feat(dispatch): 在协作花名册展示运行态`。
- 未经用户单独授权，不 commit 或 push。

## 步骤

### Step 1：补按 Bot 读取 heartbeat 的纯函数

在 `src/core/daemon-heartbeat.ts` 增加公开、只读的按 App ID 查询函数。输入至少包括 `dataDir`、目标 App ID、`nowMs` 和可选 freshness；输出必须能区分：

- heartbeat 新鲜且 `busyCount === 0`：`idle`；
- heartbeat 新鲜且 `busyCount > 0`：`busy`，带非负 `busyCount` 和标准化时间；
- heartbeat 文件缺失、损坏或过期：返回“无 fresh busy evidence”，不要自行断言 daemon 离线。

复用现有 `readBeat` 的严格解析和 `HEARTBEAT_FRESH_MS`，不要再实现一套 JSON 解析器。若需把 `readBeat` 改为可复用 helper，保持 `anyDaemonBusyTo` 行为逐字等价。

**验证**：先在 `test/daemon-heartbeat.test.ts` 写覆盖 idle、busy、stale、损坏和错误 App ID 的失败测试；确认它因新函数不存在或返回值不符而 RED，再实现并运行同一命令转 GREEN。

### Step 2：组合 daemon 在线证据和 busy 证据

扩展 `BotCollaborationFacts` 与 `BotListOutputEntry.collaboration.runtime`，新增：

```ts
availability: 'idle' | 'busy' | 'offline' | 'unknown';
busyCount?: number;
observedAt?: string;
```

在 `cmdBots` 的 `collaborationFactsFor` 中只对本机 configured Bot 组合证据：

- `listOnlineDaemons` 存在目标 App ID，且 heartbeat 新鲜：`idle` 或 `busy`；
- descriptor 在线但 heartbeat 不可用：`unknown`；
- 当前进程能读取本机 daemon registry、目标是 configured Bot、且没有在线 descriptor：`offline`；
- 隔离环境、外部 Bot、读取异常：`unknown`。

保留现有 `transport` 和 `deployment` 字段。`stale` 如继续保留，必须由真实时间戳计算，不能继续硬编码；若它与 `availability` 重复且没有兼容消费者，可在同一变更中删除并同步测试与说明。

**验证**：`bun run test -- test/daemon-heartbeat.test.ts test/daemon-discovery.test.ts test/bots-list-output.test.ts` → 新增状态矩阵全部通过。

### Step 3：更新 Bot 面向模型的字段说明

在 `src/skills/definitions.ts` 的 `botmux-bots` 文案中说明：

- `idle` 可以立即派单；
- `busy` 表示当前有执行中的 turn，但仍可排队，不是硬失败；
- `offline` 是本机有权威无在线 daemon 证据；
- `unknown` 仍是证据不足。

不得加入“自动选择最空闲 Bot”之类未实现承诺。

**验证**：扩展 `test/builtin-skills.test.ts`，断言四种状态及 busy 非硬失败语义存在；运行 `bun run test -- test/builtin-skills.test.ts test/bots-list-output.test.ts`。

### Step 4：做受影响回归

运行本计划“会用到的命令”中的聚焦测试、相关回归、`bun run check:agent` 和 `bun run build`。最后执行：

```bash
git diff --check
git diff --stat
```

确认只出现 In scope 文件，以及计划生成前 `src/cli.ts` 已存在的 `task:new` 改动。

## 测试计划

- fresh idle heartbeat + online descriptor → `availability: idle`。
- fresh busy heartbeat + online descriptor → `availability: busy` 且 `busyCount` 正确。
- online descriptor + stale/malformed heartbeat → `unknown`，不能报 idle。
- configured local Bot + 可读 registry + 无在线 descriptor → `offline`。
- 外部或隔离 fallback → `unknown`。
- 现有 reachability、workspace、authorization、session 字段保持兼容。

## Done criteria

- [ ] `botmux bots list` 对本机 Bot 输出真实的 `availability`，不再把所有 `runtime.stale` 固定成 unknown。
- [ ] busy 状态是提示信息，不阻止合法 dispatch。
- [ ] 不把外部或证据不足的 Bot 误判为 offline。
- [ ] focused tests、相关回归、`bun run check:agent`、`bun run build`、`git diff --check` 全部 exit 0。
- [ ] In scope 之外没有新增改动；既有未提交改动完整保留。

## STOP 条件

- `bun --version` 不是 `1.4.2`。
- 必须修改 daemon heartbeat 的写入频率或 descriptor 协议才能实现。
- 需要把 runtime 状态当作新的权限凭据。
- `src/cli.ts` 既有未提交代码与派单区发生重叠，无法安全区分作者。
- 同一个验证连续两次失败且原因未明。

## 维护注记

运行态是瞬时证据。未来如果加入自动调度，只能把它当负载提示，不能把一次 idle 当容量预留，也不能用它替代 dispatch acceptance。
