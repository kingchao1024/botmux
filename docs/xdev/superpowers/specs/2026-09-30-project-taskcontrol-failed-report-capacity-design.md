# Project-group TaskControl 失败终结与容量一致性设计

> 状态：宋超已于 2026-09-30 在消息 `om_x100b64f384f2e8a0e88e2caeba29241` 批准先做最小代码修复与离线验证。本文不授权部署、重启、生产配置、旧 root 终结、新 canary、completion gate、commit 或 push。

## 问题

`maxActiveMappings=1` 的目标是每个 canary 群最多存在一个未终态 audit-only mapping。当前容量门只读取 project workstream 状态；`botmux report --status failed` 会把 project 状态改为 `failed`，但 report evidence 仍按 `submitted` 处理，而且会删除已有 delivery/review。结果是 project 侧释放容量时，TaskControl 仍可能停在 `submitted`，新 mapping 可与旧非终态 mapping 并存。

生产现场中的旧任务 `78961963-5f66-4f4f-8fd7-833c81c4e612` 正好满足这个反例：project 为 `blocked`，TaskControl 只有五个事件，最后状态为 `submitted`，没有终态事件。

## 方案比较

### A. 只把 project workstream 改成 failed

改动最小，但会制造双真源，并丢失 project delivery/review 投影。拒绝。

### B. 可信 failed report + TaskControl 终态容量门（采用）

把来自当前 live worker、命中 exact dispatch binding 的结构化 `status=failed` report 编码为新的 `failed_report` evidence。controller 验证后写入 `task.failed`。project 侧保留已有 delivery/review，只更新失败状态、原因和最后回报。

新 dispatch 的容量判断不再使用 project 的 `completed/failed` 文案，也不读取最新投影状态。controller 在 project 文件锁内读取统一的 mapping decision：容量只接受两种不可变事实，一是 mapped worker、exact `project_report` artifact 和 `project_report_failed` error class 共同证明的合法 `task.failed`，二是同一轮独立签名 PASS 在 controller 首次入站时间仍有效、review/delivered/done 来自同一 reviewer evidence、`task.delivered(terminal=true)` 的 artifact 与 destination 精确一致且 outbox/receipt 已 delivered 的完整成功链。`cancelled` 在本设计中没有可信生产者，不释放容量。

容量释放与下一次 admission 分开判断。合法终态一旦建立，之后的撤销、冲突或 UNKNOWN 不会让旧 mapping 重新占用容量；admission 会按 release event 的序号独立拒绝 post-terminal UNKNOWN/conflict、later verdict/key revocation、terminal-shaped transition violation 等审计缺口。历史的 pre-terminal、非终态 transition violation 继续保留在 blocked 审计投影中，但不会单独抹掉已证明的容量终态。reservation 必须在同一项目锁内同时取得 `capacityReleased=true` 和 `admissionSafe=true`。

report CAS 先于 evidence 入账的现有顺序可以保留：两者之间若发生失败，TaskControl 仍非终态，容量门继续拒绝，因此不会错误放行。证据最终入账后才释放容量。

### C. 新增管理员 cancel/abandon API

语义最显式，但需要新的命令、真人授权格式、身份校验、幂等记录和恢复协议，改动面显著更大。当前已有可信 worker report 通道，暂不新增第二套入口。

## 状态与失败处理

1. 普通成功 report 仍生成 `submitted` evidence；review 流程不变。
2. `status=failed` 且 project CAS 成功时生成 `failed_report`，controller 写 `task.failed`。
3. `status=failed` 但 project CAS 失败时只写 `unknown.required`，不写 `task.failed`，project 也不会释放容量。
4. TaskControl-managed workstream 一旦 project 已为 `failed`，拒绝再通过普通 worker report 恢复为非终态；完全相同的失败重放保持幂等。
5. failed report 不删除已有 delivery/review；失败原因写入 `lastReport` 和 `blocker`。
6. 任何无法证明 mapping 或上述精确终态链的容量判断都 fail closed；容量已释放但 admission 不安全时仍拒绝新 reservation。

## 验收

- RED 证明 project `failed` 但 TaskControl `submitted` 时，第二个 audit-only reservation 仍被拒绝。
- RED 证明可信 failed report 当前只形成 submission，修复后形成 `task.failed`。
- RED 证明 failed report 当前会删除 delivery/review，修复后保留二者并禁止从 failed 恢复。
- project CAS 失败的 failed report 只形成 UNKNOWN，不产生虚假 terminal。
- FAIL、CONDITIONAL、UNKNOWN、wrong role/source/artifact/destination、缺少 delivered receipt 或缺少同源 done 都不能建立成功终态；合法终态后的审计缺口不反转容量事实，但必须阻断下一次 admission。
- 成功、review、rework、legacy workstream 与第一条 canary reservation 行为保持不变。
- 运行聚焦测试、TaskControl/project-group 相关回归、三套 TypeScript、`bun run check:agent` 和 `git diff --check`；独立复审无 P0/P1 后才称为代码就绪。

## 上线边界

本轮只产出未提交候选和离线证据。部署、daemon 重启、终结旧 root、创建 clean canary、修改 completion gate、commit、push、merge 或 release 都需要单独授权。
