# 三远端合并与整树一致性报告（2026-11-14）

> 当前状态：**合并已提交，遗漏测试已补齐，尚未 push**。合并提交为 `bd379bb2e`，父提交为 `77deca613` 与 `f0b3a0e72`；测试补齐提交为 `db6e978bf`。`MERGE_HEAD` 已清理。类型检查和局部回归通过，整树仍有未收敛的失败项，本报告不代表发布验收通过。

## 1. 目标与范围

把三个远端的主分支合一到本地 `master`，并让合并后的树**编译通过、可验证**：

| 远端 | 分支 / 提交 | 说明 |
|---|---|---|
| `upstream` | `upstream/master` | 上游主线，已合入（`a19c3e11f`） |
| `origin` | `origin/master` | 个人远端，已合入（`7e7595c98`） |
| `botmux-public` | `f0b3a0e72` | 第三条线，已通过 `bd379bb2e` 合入 |

- 合并基点：`75d94e46e`
- 本地 `master` 原 HEAD：`77deca613`（比基点 +156 提交）
- `botmux-public/master`：比基点 +271 提交
- 合并提交相对第一父提交的实际规模：**627 新增 / 931 修改 / 14 删除，共 1572 个文件**（`git diff --name-status bd379bb2e^1 bd379bb2e`）。原先的 620 / 905 / 14 是中途暂存区快照，不是最终提交统计。
- 测试补齐提交另纳入 5 个文件，见 §5.2。补齐前 `git status --short` 列出 49 个未跟踪项，其中既有临时目录，也有源码、测试和文档，不能统一称为「临时文件」；目录项也不等于实际文件数。

本轮已获授权并完成合并提交、测试补齐提交及报告入库。未 push、未 `bun run build`、未认领全局 CLI、未重启 daemon，也未修改生产配置。

## 2. 合并后的基线事实

- 全量类型检查 `node scripts/tsc.mjs -p tsconfig.json --noEmit`：**0 错误**。
- 合并前的 HEAD 本身就是红树。以「本次合并后仍失败」的 169 个测试文件为集合，在 HEAD 快照（`/tmp/head-wt`，独立 worktree，未 install）上跑同一集合得到：**714 个用例失败 / 123 个文件**。这是合并阶段记录的基线，本次测试补齐未重跑该集合。它说明存在既有失败，但文件数与失败总数不能证明每个失败用例都与合并无关；新增或变化的失败仍需逐例比对。
- 三条分支在若干模块上属于**同文件不同设计**（非单纯快进），典型如 `project-group-store`、`ask-broker`、`send-invocation`、`sessions-card`。合并策略：保留本地/上游更完整的安全语义，把 public 新增的能力以兼容方式接入，并对「行为不变、定位点变了」的源码锁做等价适配。

## 3. 本轮修复（生产代码）

| 模块 | 问题 | 修法 |
|---|---|---|
| `src/core/dashboard-ipc-server.ts` + `src/services/project-coordinator.ts` | report 改走 `runReport` 后，`project_attachment_revision_conflict` 的队列内复核被绕过（导入工作流授权缺口） | `runReport` 增加可选 `beforeApply`，在协调器队列/文件锁内、apply 之前执行复核 |
| `src/core/ask-api.ts` | 合并把 public 旧版 `rootMessageId` 校验塞进了 S1 解析，S1 请求全部被拒；显式无期限请求（`timeoutMs:0`）被 `isSupportedAskTimeoutMs` 拒绝 | 移除错位校验；explicit + 稳定 `requestId` 放行零期限，其余仍要求有界生命周期 |
| `src/core/ask-broker.ts` | `deadlineAt = 0` 被当作「已过期」，无期限 ask 在 gate / submitAsk / submitAskFromDesktop 三处一律 `stale` | 三处判断均跳过 `timeoutMs === 0` |
| `src/services/project-group-store.ts` | legacy 形态（`blockers: string[]`、无 `blockerRecords`）的写入被硬拒 | 刷新投影时走与磁盘迁移相同的升级路径，非法形态仍报错 |
| `src/services/group-collaboration-mode-store.ts` | `writeGroupCollaborationMode` 是 async 签名但内部用同步文件锁，持锁方会让 daemon 事件循环空转至 5s 超时 | 改为 chat → mode 文件 → project 的**全异步**加锁；锁序不变 |
| `src/adapters/cli/read-isolation.ts` | 缺 `protectedPaths` 形参，项目授权目录（journal/grant）无法进入 credential-only 拒绝表；`sessionDataDir` 被当作必填 | 移植 Home 内路径过滤版 `protectedPaths`，`sessionDataDir` 改为可选 |
| `src/services/project-coordinator-runtime.ts` | 在线探测会**清理**过期 descriptor 文件，导致随后「旧描述符兜底取名」落空 | 先对全部 owner appId 快照旧描述符名，再做在线探测 |
| `src/im/lark/sessions-card.ts` | 详情卡只发 capability view link，无 proxy 时直连端口入口整体消失 | 新增 `buildSessionTerminalUrl` 作为兜底，仍受本地地址隐藏策略（`sendableCardLink`）约束 |
| `src/core/dashboard-ipc-server.ts` | 超限分块上传在服务端 reader 抛错后请求流被 pause，`server.close()` 永久挂起 | 路由入口留存 socket，响应 flush 后销毁连接（超限正文无需再读） |
| `src/cli/send-invocation.ts` | 参数白名单漏了 `--schedule-once`，`botmux send --schedule-once` 被当成未知参数 | 补入布尔参数表 |
| `.github/workflows/ci.yml` | 一处 Bun 仍写 1.4.3，与 `packageManager: bun@1.4.4` 不一致 | 改为 1.4.4（`test/release-darwin-codesign-gate.test.ts` 守此不变量） |
| `src/im/lark/client.ts` | 应用 Token 优先的定位锚点缺失，源码锁无法证明 gate 在 fallback 之前 | 补回注释锚点（位置确在 transport gate 之后、app-token 尝试之前） |

## 4. 测试侧适配（行为不变，仅定位点变化）

以下文件属于「实现换 seam / public 新增用例与本地实现语义等价」，按新接缝校准，不改断言语义：

| 文件 | 适配内容 |
|---|---|
| `test/ask-cli.test.ts` | 补回合并丢失的 `isAskPost` 辅助函数与 `IncomingMessage` 导入 |
| `test/ask-api.test.ts` | 无期限用例改断言 `deprecatedOriginKindHint`（本地血脉的有意改名字段） |
| `test/ask-card.test.ts` | Card JSON 2.0 的 `body.elements` 与 legacy 根 `elements` 均可 |
| `test/ask-chat-scope-turn-target.test.ts` | 夹具补路由 URL 与 `askOriginKindForPath` 依赖 |
| `test/oncall-group-join-ack.test.ts` | ack 包装新增回调快照校验，夹具补 `snapshotLarkCardActionCallbackData`、`isPlainRecord`、`unwrapAskCardActionOutcome` |
| `test/dispatch-user-route.test.ts` | 交付路由依赖补齐（`readProjectGroup`、task-control fence、kickoff 等） |
| `test/worker-ready-display-mode.test.ts` | view token 补足 43 字符（本地地址清洗只信任发布形态的 read capability） |
| `test/worker-adopt-target.test.ts` | 补 `networkProxyError`、`detectAskAuthorityPresence` 夹具 |
| `test/project-card-runtime-sync.test.ts` | 建工作流改走 standard 后再切 project（本血脉要求项目模式新派单必须有 reservation） |
| `test/minimax-compact.test.ts` | 补 `disarmEffortConfirm` 夹具 |
| `test/api-only-mode-wiring.test.ts` | 中央门改查 `resolveManagedOriginTransport()` / `judgeManagedOriginTransport`；resume 通知按真实发布函数定位；wrapper 解析器/退出码/CA bundle 断言按现实现校准 |
| `test/cli-send-schedule-once.test.ts` | replay 错误码与参数拒绝文案按共享解析器实际行为放宽（仍断言「拒绝」） |
| `test/cli-send-hook-context.test.ts` | quote 目标允许多一层 reply-context 分支，frozen 兜底仍在 |
| `test/codex-hook-trust-worker-wiring.test.ts` | spawn 调用字面量放宽（新增 `retryPaneAgentStart` 形参） |
| `test/existing-app-server-worker-shutdown.test.ts` | 退出码改为参数形态（`process.exit(exitCode)`），分支顺序断言保留 |
| `test/local-address-egress.test.ts` | 依赖 `sessions-card` 新导出的 `buildSessionTerminalUrl` |
| `test/project-authority-paths.test.ts` | 依赖 `buildCredentialIsolationRules(ctx, protectedPaths)` |
| `test/project-workstream-ipc.test.ts` | 依赖异步加锁（持锁期间不再阻塞事件循环） |

## 5. 验证证据

### 5.1 合并阶段记录

以下是此前合并阶段记录的全量类型检查与 29 文件回归。本次补齐没有重跑这 29 个文件；其中 `test/cli-send-schedule-once.test.ts` 当时虽在工作区参与验证，却未纳入 `bd379bb2e`，现已在 `db6e978bf` 补齐测试及 fixture。

```text
# 类型检查（全量，非 typecheck 子集）
node scripts/tsc.mjs -p tsconfig.json --noEmit
→ 0 errors

# 本轮涉及面回归（29 个文件）
node node_modules/vitest/vitest.mjs run --project unit \
  test/ask-cli.test.ts test/ask-api.test.ts test/ask-card.test.ts test/ask-broker.test.ts \
  test/explicit-ask-continuation.test.ts test/project-import-delivery.test.ts \
  test/project-import-legacy-route.test.ts test/project-workstream-ipc.test.ts \
  test/project-workstream-attachments.test.ts test/project-card-runtime-sync.test.ts \
  test/project-coordinator-runtime.test.ts test/group-collaboration-mode-store.test.ts \
  test/dispatch-user-route.test.ts test/worker-adopt-target.test.ts \
  test/worker-ready-display-mode.test.ts test/worker-managed-origin-contract.test.ts \
  test/minimax-compact.test.ts test/api-only-mode-wiring.test.ts \
  test/ask-chat-scope-turn-target.test.ts test/local-address-egress.test.ts \
  test/oncall-group-join-ack.test.ts test/decision-board-explainer-ipc.test.ts \
  test/cli-send-schedule-once.test.ts test/cli-send-hook-context.test.ts \
  test/codex-hook-trust-worker-wiring.test.ts test/existing-app-server-worker-shutdown.test.ts \
  test/session-contract-gateway.test.ts test/release-darwin-codesign-gate.test.ts \
  test/project-authority-paths.test.ts
→ Test Files 29 passed (29) / Tests 1089 passed (1089)
```

运行方式说明：`package.json` 与 CI 使用 Bun 1.4.4，本机 `./node_modules/.bin/bun` 仍为 1.4.3。可复用的 1.4.4 二进制位于 `/tmp/bun144/bun-linux-x64/bun`，本次已执行 `--version` 确认。复跑需将其目录前置到 `PATH`，并以 `node node_modules/vitest/vitest.mjs` 启动，避免 `npx` 把 1.4.3 排到前面。`docs/agent/quality.md` 中的 1.4.3 描述已过时，本次以可执行配置为准，未改动该文档或依赖。

### 5.2 遗漏测试补齐与本次实测

`db6e978bf` 将以下文件纳入版本管理：

| 文件 | 验证范围 |
|---|---|
| `test/cli-send-schedule-once.test.ts` | 发送前认领与防重放；拒绝普通 turn、带值参数和跨群目标；允许自动完成的一次性任务当前 turn 发送 |
| `test/fixtures/send-schedule-once-capture.ts` | 拦截 SDK HTTP adapter，记录请求并返回测试响应 |
| `test/cli-send-xpi.test.ts` | prepared 内容替换正文后仍保留 `--as independent` 标记；复用已有 `send-image-mode-capture.ts` |
| `test/skill-runtime-hook.test.ts` | preflight 拒绝与放行、无 manifest、切换时间、记忆召回与保存、失败退避 |
| `scripts/skill-runtime-hook.py` | hook 测试依赖的独立 Python helper，与测试一起入库 |

运行环境为 Node `v22.16.0`、Bun `1.4.4`、Vitest `4.1.11`，实测命令：

```bash
env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/cli-send-schedule-once.test.ts \
  test/cli-send-xpi.test.ts \
  test/skill-runtime-hook.test.ts
```

结果：**3 个测试文件通过，11 个用例通过，无失败或跳过，退出码 0**。默认进程池也完成了全部断言，但本机命令沙箱将退出时的子进程 SIGTERM 记为失败；线程池复验正常退出，测试内容和断言未改变。暂存后的 `git diff --cached --check` 亦通过。

本次仅验证独立 helper 与发送测试，未接入或修改宿主 hooks 配置。`src/core/skills/invocation-audit.ts` 仍是未跟踪的开发稿，当前 CLI 没有引用；原先的 `appendSkillInvocationAudit` / `satisfySkillPreflight` 接线及对应测试保存在 `stash@{0}` 的 `src/core/skills/cli-session-command.ts` 和 `test/skill-cli-commands.test.ts` 中。未删除该稿或恢复 stash。hook 测试手动写入 satisfied 状态，不证明 CLI 的真实 preflight 释放链路已恢复。

## 6. 仍未收敛的红项（按原因分类）

### 6.1 真实 PTY / 进程集成套件

需要 fake CLI 在真实 PTY 里走完启动握手，本轮未逐条追：

- `traex-auto-model-continuation.integration`（11）：fake TRAE 始终等不到 `readyPattern`，首提示超时
- `worker-traex-question-page.integration`（6）：同类首提示超时
- `worker-agy-acp.integration`、`worker-traex-program-status.integration`、`worker-runtime-reservation-late.integration`、`worker-claude-late-session-start-submit.integration`
- `restart-reattach-turn-delivery.integration`、`restart-reattach-report-continuity[.integration]`、`retired-runtime-worker-exit.integration`、`dormant-wake-final-output.integration`、`live-worker-cap-pending-final.integration`、`identity-decision-opening-turn.integration`、`antigravity-acp-reattach.integration`

### 6.2 依赖 fresh `dist/` 的套件

- `credential-only-dispatch-flow.integration`（10）、`credential-only-send-authority`
- 合并阶段记录：这些用例的 `canRun` 条件是 `existsSync(dist/cli.js)`；HEAD 快照没有 dist 因而整组 skip。本 checkout 的 `dist/cli.js` 时间为 **2026-11-05 13:46:39 +0800**，早于本次合并；原报告误写为 2025 年。旧产物是这些失败的环境差异之一，尚不能据此确认全部错误的根因。**使用 fresh 构建产物后需重跑**；本轮未构建，原地覆盖现有 `dist/` 的授权与运行影响需另行确认。

### 6.3 HEAD 已有失败基线（新增失败仍待比对）

- `test-hygiene`（约 130 处未标注的源码文本断言）
- `bridge-final-output-retry`（HEAD 12 红 / 现 10 红）
- `workflow-bot-executor-approve`（HEAD 21 红 / 现 22 红）
- `worker-idle-queue-stall`（HEAD 36 红 / 现 6 红，反而收敛）
- `workflow-c0-isolation`、部分 `session-lifecycle-start`、`traex hook` 集成等

上述总数来自合并阶段记录。尤其 `workflow-bot-executor-approve` 从 21 红变为 22 红，不能直接判为「与合并无关」；需比对失败用例及原因。

### 6.4 契约路径三类（4 个失败用例，待深挖）

`runtime-rebind-turn-delivery`（2）、`reattach-stale-turn-screen-status`（1）、`schedule-repair-adversarial-review`（1）。

现象：拒绝 final 时本应走 `reportUndeliveredFinal` 发 `⚠️` 群提示并记录 `Final output from current worker not delivered`，实际先落到 `Dropped managed_turn_origin_revoked ... stale_runtime_scope`，final 未进入该分支。合并阶段记录称，相关模块（`session-controller`、`session-contract`、`session-event-scope`、`session-command-gateway`、`output-delivery-journal`、`session-store`）与 public `f0b3a0e7` **逐字一致**。这使 worker-pool 合并后的准入分支成为重点排查方向，但尚未排除夹具、依赖与运行环境差异，不能确认它是唯一原因。本次仅补测试与报告，未定位或修复这些失败。

## 7. 当前仓库状态与后续动作

- `bd379bb2e` 已固化合并阶段的源码与已跟踪测试修复；`db6e978bf` 补齐 §5.2 的 5 个测试及配套文件。
- 本报告随独立文档提交入库。测试补齐后无已跟踪文件的未提交改动，剩余未跟踪项仍包含开发稿、历史文档与临时产物。
- `stash@{0}`（`pre-merge-worktree-20261113`）为合并前的用户改动，**未动**；`src/core/skills/invocation-audit.ts` 开发稿原样保留。
- 后续顺序建议：
  1. 在确认构建范围与授权后，用 fresh 产物重跑 §6.2；
  2. 按 §6.1、§6.4 逐条定位；§6.3 对已有失败与新增失败逐例比对，再决定哪些单列为技术债；
  3. 若要恢复技能审计与真实 preflight 释放，单独核对 stash 中的接线与当前 CLI 契约，再实施并验证。
- 未做且需另行明确范围与授权：push、重建现有 `dist/`、`bun run switch:here`、daemon 重启、任何 live 手测。
