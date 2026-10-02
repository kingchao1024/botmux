# Project 阶段终态自动推进设计

## 背景与授权

TaskControl 已能可靠地完成 `dispatch -> report -> review`，但阶段终态后的下一步仍依赖主控在当前 turn 中自行继续。主控若提前结束，安全动作不会继续，高权限动作也不会自动形成待授权事项，只能等待巡检或用户再次追问。

宋超已授权按以下顺序推进：先固化 T19 本地提交，再设计并实现自动推进机制，完成 TDD、离线验证和两轮串行独立复审。T19 本地提交为 `2617528d8e9e384dd04f6c5f6f1915fa4661b137`。本设计不授权 push、merge、部署、daemon/service 重启、生产配置、live canary 或 completion gate 变更。

## 目标

项目 workstream 到达可推进的阶段边界后，系统生成一个可恢复、可去重的自动推进事件，并把它投递给原项目主控会话。主控收到可信事件后完成一次收敛判断：

- 下一步仍在已有授权范围内时，直接继续执行；
- 下一步需要 commit、push、merge、部署、重启、删除、生产配置、权限扩大、真实设备或外部协调时，停止执行，原子更新本专项群的 human-action ledger，并在群顶层主动请求授权；
- 同一阶段事件、同一授权请求和同一投递结果均不能重复产生副作用；
- 投递前失败可恢复；投递结果不明时不得盲目重跑。

## 非目标

- 不在底层 TypeScript 代码中解析自然语言并判断某个具体 shell 命令是否获授权。
- 不让 daemon 直接执行 commit、push、部署、重启或其它业务动作。
- 不替换现有项目角色、human-action ledger、`botmux send --top-level` 落点规则或 TaskControl reviewer verdict。
- 不在本轮新增通用工作流引擎、规则 DSL、数据库或外部依赖。
- 不处理普通聊天、非 project_group 会话或没有 durable project state 的任务。

## 现状证据

- `ProjectCoordinator.runReport()` 在项目 store 锁内持久化 delivery/review 状态，再更新项目卡；正式 reviewer PASS 会把 write workstream 从 `in_review` 转为 `completed`。
- `/api/project-groups/:chatId` 的 report 路由已运行在可信 daemon 内，能取得 project、原 `coordinatorSessionId` 和 active session registry。
- `triggerSessionTurn()` 已支持向既有 session 投递异步 follow-up，并用 `turnIdempotencyKey` 保证同一 session 内的 at-most-once 语义。
- `human-action-watch/<chatId>.json` 已由 `schedule-runtime-state-store` 提供 CAS、文件锁、追加不删除和稳定 fingerprint 校验。
- 现有项目巡检只能延迟补漏，不能证明阶段终态事件已即时进入主控处理。

## 方案比较

### 方案一：继续只靠巡检 prompt

优点是无需改代码。缺点是推进延迟依赖巡检周期，任务结束与下一步判断之间没有 durable 事件，也无法区分“尚未触发”和“触发失败”。该方案不能满足本轮目标。

### 方案二：report 成功后直接 fire-and-forget 一个主控 turn

优点是改动最少。缺点是 project 已提交但 trigger 尚未建立 idempotency lease 时进程崩溃会永久丢事件；触发响应丢失时也缺少可恢复状态。该方案只适合 best-effort 通知，不适合控制面推进。

### 方案三：durable stage event + 幂等主控 trigger

在 project store 的同一原子 mutation 中记录 pending stage event；可信 daemon 以稳定 fingerprint 作为 `turnIdempotencyKey` 投递原 coordinator session。投递成功后把 trigger 身份写回事件；进程在任一边界崩溃时，可从 durable event 恢复并以同一 key 重试。底层只负责可靠唤醒，下一步决策仍由主控按现有角色和 ledger 完成。

采用方案三。它比方案二多一个很小的持久状态机，但补齐了事件不丢、重复投递不重复执行和失败后可恢复三个核心不变量。

## 触发边界

v1 只处理项目 workstream 的明确状态跃迁，不监听任意文本或普通 `project update`，避免自触发循环：

- write workstream 首次进入 `in_review`：需要主控安排 reviewer 或核对既有 reviewer；
- reviewer PASS 使 workstream 首次进入 `completed`：需要主控判断下一阶段；
- reviewer FAIL 使 workstream首次进入 `blocked`：需要主控按原范围续推返修或升级授权；
- worker 显式进入 `failed`：需要主控判断可恢复、合法等待或人类介入；
- read-only workstream 首次进入 `completed`：需要主控判断下一阶段。

相同 report 的幂等重放、相同 reviewer verdict 的重放，以及只更新进度但未跨越上述边界的 report，不生成新事件。project close、completion gate 变更和普通项目文案更新不触发 v1。

## 持久状态

在 `ProjectGroupState` 增加可选、向后兼容的 `stageAdvanceEvents`，最多保留 64 条：

```ts
interface ProjectStageAdvanceEvent {
  schemaVersion: 'ProjectStageAdvanceEvent.v1';
  fingerprint: `psa1:${string}`;
  kind: 'delivery_ready' | 'review_passed' | 'review_failed' | 'workstream_failed' | 'workstream_completed';
  dispatchRoot: string;
  deliveryRound?: number;
  reviewRound?: number;
  projectRevision: number;
  status: 'pending' | 'dispatching' | 'dispatched' | 'blocked';
  createdAt: string;
  updatedAt: string;
  claimId?: string;
  claimExpiresAt?: string;
  targetSessionId?: string;
  triggerId?: string;
  attemptCount: number;
  lastErrorCode?: string;
}
```

fingerprint 只取稳定业务身份：schema、chatId、dispatchRoot、kind、deliveryRound、reviewRound。它不包含时间、错误文本或 project revision；同一阶段重放得到同一 fingerprint。`projectRevision` 只作审计和上下文，不参与去重。

只裁剪最旧的 `dispatched` 记录；`pending`、有效 `dispatching` 和 `blocked` 记录永不因容量裁剪而丢失。旧 project state 缺少该字段时按空数组读取。

## 原子状态机

项目 store 是 stage event 的唯一 durable owner。所有迁移使用现有 project 文件锁和 CAS 语义：

1. workstream 状态在 report mutation 中跨越触发边界时，同一 mutation 追加 `pending` event；状态更新与事件生成不可分离。
2. dispatcher 原子执行 `pending -> dispatching`，写入随机 `claimId`、短租约和递增 `attemptCount`。
3. daemon 调用 `triggerSessionTurn()`，目标为该项目的 `coordinatorSessionId`，`turnIdempotencyKey` 使用 event fingerprint。
4. trigger 返回 accepted、queued 或 idempotent reuse 后，以匹配的 `claimId` 执行 `dispatching -> dispatched`，保存 `targetSessionId` 与 `triggerId`。
5. 明确的 pre-dispatch 失败释放回 `pending` 并记录错误；后续 report、项目 refresh 或 daemon 恢复扫描可以再次 claim。
6. 进程在 trigger 接受后、状态回写前崩溃时，租约到期后使用同一 `turnIdempotencyKey` 重试；trigger store 必须复用原 turn，不得生成第二个 turn。
7. 已进入 worker 的结果不明、async terminal 为 failed/interrupted、目标 session 身份漂移或幂等冲突时，事件进入 `blocked`，不得自动重放可能已产生业务副作用的 turn。

v1 不自动把 `dispatched` 改为业务完成。它只证明一次推进 turn 已可靠交给原主控。主控产生的新 project/workstream 状态会形成新的、不同 fingerprint 的后续事件。

## 主控 turn 合同

trigger 使用内部可信 instruction，业务 payload 仍保持 untrusted。instruction 包含 event fingerprint、来源 workstream、轮次和以下固定要求：

1. 重新读取当前 project status、来源 `dispatchRoot` 最新消息和本群 human-action ledger；旧快照只作线索。
2. 判断唯一下一步。已有授权明确覆盖时，在原 root、原 owner、原工作树继续；不能扩大范围或创建重复 owner。
3. 下一步需要新授权或真人动作时，不执行该动作。用 `psa1` fingerprint 与动作摘要派生稳定 human-action fingerprint，CAS upsert ledger，再按用户通知落点协议发到当前专项群顶层并回读验证。
4. 同一 human-action fingerprint 已为 `waiting_human`、`in_progress` 或 `closed` 且事实未变化时，不重复询问。
5. 更新 durable project phase、focus、remaining 和 blocker；没有用户可见信息时保持静默。

自动推进 turn 不携带真人身份，也不产生新的操作权限。任何要求当前真人 turn、`canOperate` 或 canonical authorization summary 的接口继续由现有 runtime gate 拒绝。

## 调度与恢复

- report 路由在 durable project mutation 和卡片投影之后尝试 drain 当前事件；auto-advance 失败不回滚已经成功的 report。
- IPC server readiness 完成后扫描当前 app 管理的 active projects，恢复 `pending` 和租约已过期的 `dispatching` 事件。
- `project refresh` 也触发一次 bounded reconcile，给运维一个无新增业务副作用的恢复入口。
- 每次 reconcile 每个 project 最多 claim 一条事件，不在一个 tick 内形成递归推进风暴。
- 单个事件最多三次明确 pre-dispatch 重试；之后进入 `blocked` 并把错误投影到 project blocker。未知投递结果不消耗为普通 retry，而是先走 idempotency lookup。

## 安全与通知边界

- daemon 不直接执行业务下一步，也不直接把自然语言解释为授权。
- 自动 turn 只能投递项目绑定的 `coordinatorSessionId` 和 `larkAppId`，不能由请求体覆盖。
- 不自动创建新群、新话题、新 worktree、新 owner 或 completion gate。
- 面向宋超的通知只能由主控按现有协议发送到当前专项群顶层，并验证 `rootId` 为空。
- human-action ledger 不保存 secret、token、凭证明文或完整终端输出。
- 自动事件不得触发 push、merge、部署、重启、删除、迁移、生产配置、权限扩大或真实设备操作。

## 最小实现范围

建议在基于 `2617528d8` 的独立 worktree 中实现，避免当前共享工作树的其它未提交改动：

- 新增 `src/services/project-stage-auto-advance.ts`：canonical fingerprint、事件派生、claim/settle/reconcile 和 trusted instruction builder。
- 修改 `src/services/project-group-store.ts`：可选事件 schema、严格校验和向后兼容读取。
- 修改 `src/services/project-coordinator.ts`：在 report 的原子状态跃迁中生成事件；提供内部 claim/settle mutation。
- 修改 `src/core/dashboard-ipc-server.ts`：report 后与 readiness 后 bounded drain，复用 `triggerSessionTurn()`。
- 新增 `test/project-stage-auto-advance.test.ts`：纯状态机、fingerprint、租约与恢复。
- 修改 `test/project-group-mode.test.ts`：workstream 触发边界、重放去重和 project store 持久化。
- 修改 `test/dashboard-ipc.test.ts`：原 coordinator session 绑定、stable turn idempotency、失败恢复和不回滚 report。
- 本设计文档。

只有现有测试 seam 无法注入 trigger 依赖时，才允许增加一个仅供 runtime 注册与测试替换的 handler setter；不得修改公共 CLI/API、持久 human-action schema、TriggerRequest schema、依赖或配置。

## TDD 顺序

1. RED：write delivery 首次进入 `in_review` 时没有 durable event；重复 delivery 不得产生第二条。
2. RED：review PASS/FAIL 和 worker failed 各生成一个独立 fingerprint；重放不重复。
3. RED：trigger 首次明确失败后事件可重新 claim；接受后崩溃再 reconcile 必须复用相同 turn，不产生第二次 worker dispatch。
4. RED：未知投递或 target session 漂移进入 `blocked`，不能自动重放。
5. RED：trusted instruction 要求核对项目、原 root 和 ledger；权限动作只能转 human-action + 顶层通知，不能直接执行。
6. GREEN：逐条最小实现，保持现有 report durability、review round、card projection 和 TriggerRequest 行为不变。

## 验收

- 新增聚焦测试全部完成真实 RED -> GREEN。
- project store 兼容旧 state；重复 report/review 不增加 event 或 project revision。
- 两个独立 coordinator 实例共享同一 project store 时，只能有一个 claim 成功。
- 注入 pre-dispatch 失败、trigger accepted 后回写前崩溃、幂等复用、未知 terminal 四类故障，结果符合状态机。
- 安全动作提示会唤醒原 coordinator session；权限动作提示包含 ledger 和顶层通知硬约束，且没有 direct privileged executor。
- 运行相关 project/report/trigger/session suite、三套 TypeScript、`bun run check:agent`、`git diff --check` 和 Bun 1.4.2 `bun run build`。
- 第一 reviewer PASS 后再启动第二 reviewer；两位 reviewer 都要做至少两轮 fresh hostile，P0/P1/P2 阻断项清零才算离线 PASS。

## 回滚

实现阶段不 push、不部署。若 TDD 或复审失败，停止在隔离 worktree，保留 RED、diff 和日志。若已形成新的本地 commit，只使用新增 revert commit 回滚，不 reset、不覆盖共享工作树。运行时开关默认不新增；若实现最终需要 kill switch，必须先扩大设计并重新取得确认。
