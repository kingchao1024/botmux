# 三远端合并与整树一致性报告（2026-11-14）

> 提交前验收状态：**三远端 master 已包含在本地；暂存行为已恢复，原 25 个验收失败和 3 个 PTY 失败已修复；15 个隔离用例仍受环境限制**。验收基线 HEAD 为 `734b66252`，合并提交为 `bd379bb2e`。最新验收见 §9；§6 和 §8 保留此前记录。本报告不代表整树发布验收通过。

2026-11-14，用户已授权将恢复的源码、验收修复、相关测试、本报告及 CLI 已引用的 `src/core/skills/invocation-audit.ts` 纳入提交，并推送至 `origin/master` 和 `upstream/master`。下文“未提交、未 push”描述各阶段验收结束时的状态；后续提交 ID 和远端同步结果以 Git 记录为准。

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

此前已完成合并提交、第一次测试补齐提交及报告入库。本次重新拉取后，在工作区恢复遗漏改动，并在独立副本构建验收；未 push、未覆盖运行中的 `dist/`、未认领全局 CLI、未重启 daemon，也未修改生产配置。

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

### 5.2 第一次遗漏测试补齐与当时实测

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

第一次补齐仅验证独立 helper 与发送测试。当时 CLI 尚未引用 `src/core/skills/invocation-audit.ts`，hook 用例也手动写入 satisfied 状态。**本次已恢复审计与 preflight 接线，并把 hook 用例改为调用真实 `runSkillSessionCommand` 读取 TDD 后验证 Python helper 放行**，见 §8。该审计源码仍为未跟踪文件，后续提交时必须随引用方一起纳入。

## 6. 首次合并时的红项分类（最新结果见 §9）

### 6.1 真实 PTY / 进程集成套件

需要 fake CLI 在真实 PTY 里走完启动握手，本轮未逐条追：

- `traex-auto-model-continuation.integration`（11）：fake TRAE 始终等不到 `readyPattern`，首提示超时
- `worker-traex-question-page.integration`（6）：同类首提示超时
- `worker-agy-acp.integration`、`worker-traex-program-status.integration`、`worker-runtime-reservation-late.integration`、`worker-claude-late-session-start-submit.integration`
- `restart-reattach-turn-delivery.integration`、`restart-reattach-report-continuity[.integration]`、`retired-runtime-worker-exit.integration`、`dormant-wake-final-output.integration`、`live-worker-cap-pending-final.integration`、`identity-decision-opening-turn.integration`、`antigravity-acp-reattach.integration`

### 6.2 依赖 fresh `dist/` 的套件（构建已通过，隔离环境用例仍未验完）

- `credential-only-dispatch-flow.integration`（10）、`credential-only-send-authority`
- 合并阶段的 HEAD 快照没有 dist，因而存在整组 skip；本 checkout 运行中的旧 `dist/cli.js` 时间为 **2026-11-05 13:46:39 +0800**，早于合并。本次在独立副本完成 fresh 构建并复跑，结果为 **5 passed / 15 skipped**。`canRun` 同时要求实际 bubblewrap 运行探测成功；本机工具沙箱拒绝 `/dev/fuse`，探测返回 `supported:false`。因此 15 个依赖隔离运行的用例仍未验证，不能将旧 dist 判为原失败的唯一原因，也不能据退出码 0 宣布该组通过。

### 6.3 HEAD 已有失败基线（新增失败仍待比对）

- `test-hygiene`（约 130 处未标注的源码文本断言）
- `bridge-final-output-retry`（HEAD 12 红 / 现 10 红）
- `workflow-bot-executor-approve`（HEAD 21 红 / 现 22 红）
- `worker-idle-queue-stall`（HEAD 36 红 / 现 6 红，反而收敛）
- `workflow-c0-isolation`、部分 `session-lifecycle-start`、`traex hook` 集成等

上述总数来自合并阶段记录。尤其 `workflow-bot-executor-approve` 从 21 红变为 22 红，不能直接判为「与合并无关」；需比对失败用例及原因。

### 6.4 契约路径三类（原 4 个失败用例，本次已修复）

`runtime-rebind-turn-delivery`（2）、`reattach-stale-turn-screen-status`（1）、`schedule-repair-adversarial-review`（1）。

已逐例复现。`reattach-stale-turn-screen-status` 和 `schedule-repair-adversarial-review` 各一例仅缺少终态回调新增的 `workerGeneration: 1` 上下文，已补精确断言。

`runtime-rebind-turn-delivery` 两例是实际诊断遗漏：历史 final 通过历史事件准入后，已失去生命周期修改权；普通交付函数会静默放弃。本次在 `worker-pool` 调用交付前检查所有权，失去权限时调用 `reportUndeliveredFinal(msg, 'lifecycle_authority_revoked')`，保留拒绝旧 runtime 的权限契约，同时补回未交付提示及日志。该测试文件最终没有修改。三文件回归共 **49 个用例通过**（18 / 6 / 25）。

## 7. 当前仓库状态与后续动作

- `bd379bb2e` 已固化合并阶段的源码与已跟踪测试修复；`db6e978bf` 补齐 §5.2 的 5 个测试及配套文件。
- `734b66252` 固化第一次报告。本次源码、回归与报告更新留在工作区，未创建新提交。
- 五份 stash 均保留，未 apply、pop 或删除。本次只读取 `stash@{0}`，按现有实现逐项移植；其他 stash 和未跟踪稿未改动。
- 后续提交需包含 `src/core/skills/invocation-audit.ts`，否则 CLI 新导入无法编译。
- 生产发布仍需另外处理：push、覆盖现有 `dist/`、CLI 认领、daemon 重启、live 手测。本次隔离构建仅用于验收。

## 8. 重新拉取与逐项核对

### 8.1 远端包含关系

执行 `git fetch --all --no-tags` 后，三个远端 master 都没有新增提交。以下 `ahead / behind` 以本地 `HEAD` 为左侧；右侧为 0 表示远端提交已全部包含，无需追加合并。

| 分支 | 提交 | ahead / behind |
|---|---|---|
| 本地 `master` | `734b66252` | — |
| `origin/master` | `7e7595c98` | 398 / 0 |
| `upstream/master` | `77deca613` | 274 / 0 |
| `botmux-public/master` | `f0b3a0e72` | 159 / 0 |

### 8.2 合并前 stash 的 21 文件清单

`stash@{0}` 为 `pre-merge-worktree-20261113`，相对父提交修改 21 个文件、1933 行新增 / 99 行删除。逐项核对结果如下；已有等价实现或 public 新增内容均保留，没有整文件覆盖。

| 文件 | 本次处理 |
|---|---|
| `LOCAL_OVERLAY.md` | 恢复本机 master 开发、可选同步、隔离构建和 root fleet 运行约定 |
| `docs/superpowers/specs/2026-09-23-traex-bot-skill-governance-design.md` | 恢复治理修订，旧配置表标为历史快照；不操作宿主 hooks |
| `src/core/session-manager.ts` | 恢复跨群父级完成门及当前人类授权约束 |
| `src/core/skills/cli-session-command.ts` | 恢复读取审计与成功 show 后 preflight 放行；错误继续走原有外层诊断 |
| `src/core/skills/prompt.ts` | 强制技能触发后匹配并读取入口 |
| `src/im/lark/message-parser.ts` | 补回 quoted reply 的 chatId；已有其他引用字段保留 |
| `src/im/lark/project-group-card.ts` | 两种模板展示完成门计数，处理过期与退休；不展示证据与授权内部字段 |
| `src/services/structured-bridge-clis.ts` | 恢复有界 pre-start lease 的统一阻塞判断 |
| `src/skills/definitions.ts` | 恢复 TaskControl 边界及引用消息说明 |
| `src/worker.ts` | 恢复跨结构化 CLI 的提交等待保护，丢弃早于 turn start 的旧屏幕样本；保留 public 的 program-status busy 保护 |
| `test/builtin-skills.test.ts` | 补回 TaskControl 边界断言 |
| `test/dashboard-ipc.test.ts` | 用参数化用例补齐 gate / canary 人类授权、身份与 prompt 防篡改、host 维护、Phase A 发送、放弃重入及只读 tombstone / certificate |
| `test/message-parser.test.ts` | 补回 quoted chatId 回归 |
| `test/project-group-card-table.test.ts` | 补完成门和 audit-only 隐私覆盖；保留 public 原用例 |
| `test/report-session-relay.test.ts` | 差异仅两行空白；不恢复无行为变化的格式改动 |
| `test/schedule-runtime-state-store.test.ts` | 用参数化用例补齐初始状态、重放、发送前后重试、新 run 时间及禁止凭空生成 messageId |
| `test/session-lifecycle-start.test.ts` | 保留现有单次终态证明覆盖；补错 attempt、policy-only、失效/写入失败新 origin、旧 worker/错 session 及省略 attempt 的边界；使用围栏内目录；将过时的 schedule FIFO 排除断言改为验证排队及 creator 身份保留 |
| `test/skill-cli-commands.test.ts` | 补审计、入口读取放行与失败不放行；保留 public 资源诊断 |
| `test/skill-prompt.test.ts` | 补强制读取断言 |
| `test/structured-bridge-clis.test.ts` | 补有界等待与完整终态能力边界 |
| `test/xpi-shared-cwd-daemon-callbacks.test.ts` | 恢复 activeInteractiveTurn 的 caller / prompt 精确断言 |

另外增加 `test/structured-redrive-program-status.test.ts` 的真实 worker 函数回归，使用真实 `CodexBridgeQueue` 验证 lease 到期可恢复、已开始 turn 的旧样本被丢弃，同时验证 public 原有 Claude / Pi 行为。调整 `test/skill-runtime-hook.test.ts`，使 preflight 验收经过真实 CLI 入口。

### 8.3 验收范围

全量源码类型检查 `node scripts/tsc.mjs -p tsconfig.json --noEmit` 已通过。定向终态身份复验 **18 个用例通过**，425 个非目标用例由 `-t` 筛选跳过。有界等待及 program-status 测试 **11 个用例通过**；防重发账本 **30 个用例通过**；卡片隐私与模板 **24 个用例通过**。

联合回归实测命令：

```bash
env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/builtin-skills.test.ts test/message-parser.test.ts \
  test/project-group-card-table.test.ts test/project-group-mode-api.test.ts \
  test/structured-bridge-clis.test.ts test/worker-bridge-queue-hold-wiring.test.ts \
  test/codex-bridge-queue.test.ts test/skill-cli-commands.test.ts \
  test/skill-prompt.test.ts test/skill-runtime-hook.test.ts \
  test/xpi-shared-cwd-daemon-callbacks.test.ts test/runtime-rebind-turn-delivery.test.ts \
  test/reattach-stale-turn-screen-status.test.ts test/schedule-repair-adversarial-review.test.ts \
  test/schedule-runtime-state-store.test.ts test/structured-redrive-program-status.test.ts
# 16 files / 567 tests passed；无失败、无跳过，退出码 0

env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/dashboard-ipc.test.ts test/session-lifecycle-start.test.ts \
  -t 'project report trust boundary|terminalTurnOrigin|hostile: normalized|revokes the exact live capability at terminal|TraeX RPC ordinary follow-up FIFO policy'
# 2 files / 96 tests passed；815 个非目标用例由筛选跳过，退出码 0
```

两组共覆盖 18 个不同测试文件、663 个通过用例。大型 suite 的目标覆盖全部通过，**整套仍有其他失败**；目标测试通过不替代整树发布验收。

### 8.4 独立构建与环境边界

在 `.tmp/merge-recheck-20261114-vj8ef7il` 复制当前文件，包括未跟踪的审计源码；复用现有 `node_modules`，没有 install。按 `package.json` 的 build 顺序逐阶段执行生成脚本、全量编译、`tsconfig.typecheck.json` 检查、runtime build id、dashboard bundle 和两项产物审计，全部通过。因现有 Bun shim 与当前环境不兼容，直接使用 Node 脚本和已验证的 Bun 1.4.4 执行，没有调整依赖。

fresh runtime build id：

```text
16b18b02a5376333745ce08d06597a2aad15626b5cdfe15bc76fd5f74ecf4eb7
```

新产物不是部署候选版本，没有替换正在运行的产物。`credential-only-dispatch-flow.integration` 的 10 例全部跳过；`credential-only-send-authority` 的 5 例通过、5 例跳过。实际隔离探测失败并伴随工具沙箱的 `/dev/fuse` 拒绝，后续须在支持该隔离机制的验收环境复跑。

运行中的两个文件在验收前后 SHA-256 一致：

```text
dist/cli.js     7d10e09eeef4b851c1442e649964da58ec53a015df1735774ba11dcc79b702f7
dist/worker.js  22fe017a35a16bb0b50727edf2dbd86b0993814aa2de518cf9d815904bc7c454
```

`git diff --check` 已通过，五份 stash 保留，审计源码开发稿未改动。

### 8.5 首次完整套件、基线逐例比对及剩余项

完整复跑 `dashboard-ipc` 得到 **453 passed / 12 failed / 3 skipped**。`session-lifecycle-start` 第一次完整复跑有 17 个失败；随后恢复 schedule 排队断言，并修复下述 3 个夹具，最终完整复跑得到 **430 passed / 13 failed / 0 skipped，共 443 例**：

```bash
env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/session-lifecycle-start.test.ts \
  --reporter=json --outputFile=.tmp/merge-lifecycle-final-20261114.json
```

将最初这两套的 29 个失败按同名用例，在两个独立基线上复跑：

| 基线 | 结果 | 结论 |
|---|---|---|
| 合并后、恢复前 `734b66252` 的未修改副本 | 29 failed / 830 非目标用例 skipped | 这 29 例在本次恢复前已失败 |
| 合并前 `77deca613`，复用 `/tmp/head-wt` | 26 failed / 3 passed / 765 非目标用例 skipped | 其中 3 例属于合并后的新失败，不能归为历史失败 |

这 3 例分别为 `waits quietly for a non-codex cold start and follow-up to commit`、`freezes sandbox read and network policy on fresh sessions before spawning`、`records Forge x TraeX launch mode on fresh sessions and sends it to the worker`。原因是夹具的 `getBot.mockReturnValueOnce` 只保证首次查询：合并后的准备阶段增加一次读取，后续查询回落到默认 Codex。已改为稳定的 `mockReturnValue`，仍精确验证 CLI、sandbox read/network 和 Forge 启动模式；生产逻辑与断言要求均未放宽。这 3 例在最终完整复跑中全部通过。

schedule 排队原失败是过时断言：生产代码显式把 `schedule_creator` 输入排到当前 turn 之后，stash 也删除了旧排除项。本次保留独立用例，验证 `queueAfterActiveTurn:true` 和 schedule creator 身份完整保留。

**最终这两套仍有 25 个失败，均在合并前同名用例上复现**。这仅说明它们不是本次合并新增失败，不表示对应功能正确，仍需逐项定位：

| 套件 / 范围 | 数量 | 具体待处理行为 |
|---|---:|---|
| `session-lifecycle-start`：protected MCP env | 3 | normal/adopt env-source 拒绝字段；live reinjection 后剔除 daemon 保护值 |
| 同套：protected HTTP egress freezing | 6 | enabled policy、legacy resume、不存在策略、冻结策略复用、冻结缺省值、并发冲突后 durable policy 回读 |
| 同套：worker inheritance | 1 | worker env 不应包含 daemon sentinel / token / egress socket locator |
| 同套：protected egress adopt | 1 | 已有进程不能获得冻结 network boundary 时应拒绝 adopt |
| 同套：explicit reasoning effort | 2 | fresh / restore 的显式 high pin 应进入 worker init |
| `dashboard-ipc`：origin attest | 1 | 当前 Bot 的 arbitrary-mention 权限及同 turn 撤销 |
| 同套：schedule host paths | 1 | scheduleWorkingDir 应使用验证后的默认目录 |
| 同套：restart | 3 | frozen runtime 名称卡片；无 worker 的活跃会话 restart；发送异常返回 502 |
| 同套：MiniMax schedule override | 5 | 拒绝新 model/effort override，允许清除旧 override |
| 同套：group create | 2 | chatMode / collaboration 参数拒绝；缺 bindWorkingDir 时应在建群前拒绝 |

真实 worker / PTY 另外复跑 `worker-traex-program-status.integration` 与 `worker-claude-late-session-start-submit.integration`，共 **6 passed / 3 failed，退出码非零**。失败明确保留：

- Claude：`submits the first prompt left in the composer once the late SessionStart arrives`，等不到 dropped submit attempts；日志同时显示 relay entry 不可运行、tmux 退回无 OSC handshake 的直接启动。
- TraeX tmux：`unknown footer released by the startup idle report`，等不到首次输入写入。
- TraeX tmux：`the idle reported with the session-lock page does not make the session ready`，等不到 held first message 的 lock card。

这些运行中存在测试 systemd fence 拒绝和沙箱子进程退出记录，尚未确认失败的唯一根因，也未做合并前同场景比对，不能直接归为环境失败或历史失败。其余 §6.1 的 PTY 套件以及原 169 个失败文件集合，本次没有全量复跑。

本轮收尾：源码遗漏、目标回归和 3 个合并新增夹具失败已处理；剩余 25 个既有失败、3 个 PTY 失败及 15 个隔离运行跳过项明确保留。两份本次构建/基线副本与临时 JSON 结果文件在摘录证据后清理；原有 `/tmp/head-wt` 和用户暂存稿保留。本轮未创建新提交，未 push，未部署或重启。

## 9. 剩余验收问题修复（2026-11-14）

本次按“解决剩下的验收问题”处理 §8.5 的 25 个失败、3 个 PTY 失败和 15 个隔离运行跳过项。原 169 个失败文件集合及其他 PTY 套件不在本次范围。

### 9.1 已修复的行为

| 范围 | 修复与实际验证 |
|---|---|
| protected MCP env，3 例 | normal / adopt fork 从当前全局配置获取保护变量名，包括被拒绝的旧 env-source 字段；继承环境和初始化 overlay 均剔除保护值。overlay 剔除后重新计算 fingerprint，restart 也复用此解析路径。 |
| protected HTTP egress freezing，6 例 | worker init 携带 session 冻结的策略或明确的缺省值；复用冻结策略，不重新解析 DNS。仅有策略时仍不授予 actor capability。 |
| worker inheritance，1 例 | fork 环境同时剔除 `BOTMUX_PROTECTED_EGRESS_SOCKET`。 |
| protected egress adopt，1 例 | 无法把 spawn 时的保护边界施加到已有进程时拒绝 adopt，清理 stale adopt 标记；不启动 DNS 或 worker。 |
| explicit reasoning effort，2 例 | fresh / restore 使用已有 `resolveSessionLaunchEffort`，将合法的 pin effort 传入真实 init。 |
| origin attest，1 例 | arbitrary-mention 权限只取 owning Bot 的当前配置，同 turn 撤销立即进入下一份证明；不采信请求 body 的权限声明。 |
| schedule host paths，1 例 | `scheduleWorkingDir` 使用验证后的 Bot 默认目录，无可用默认值时回落 daemon cwd；不额外写入 Bot 配置。 |
| restart，3 例 | 无 worker 的活跃会话也走协调器；IPC 发送异常返回 502。状态卡使用冻结的 runtime 名称，并随协调器结果更新。 |
| MiniMax schedule override，5 例 | 写入校验复用 `allowsTaskModelOverride`，拒绝新 model / effort override，允许清除旧 override。 |
| group create，2 例 | 校验并传递 `chatMode: group / topic` 与布尔 collaboration 参数；启用时复用现有 grant matrix。补齐夹具对 `chatMode: undefined` 的完整期望，消除断言失败导致的 mock 污染；原“目录无效时不得建群”断言保留。 |

额外的相邻回归发现：worker 已退出、工作目录已删除时，协调器会先销毁仍活着的 pane，再被 fork 拒绝。现已在销毁前复用 worker pool 的目录解析和 missing-dir 回调，报告失败并保留 pane；真实 lifecycle 回归验证了 pane 未被 kill、恢复回调被调用、状态卡最终为红色。

protected MCP 本次仅恢复隔离元数据和变量剔除。当前 worker pool 没有 secret provisioning transport，`capabilities` 保持空数组，不读取或传输文件 secret；这些测试不能替代完整的受保护 egress / actor 写能力验收。

### 9.2 回归记录

首次修复后的两套完整回归：`dashboard-ipc` **465 passed / 0 failed / 3 skipped**，`session-lifecycle-start` **443 passed / 0 failed / 0 skipped**，共 908 个通过用例。原 25 个失败均已清零。

相邻 protection / model / env / restart 检查首轮为 **321 passed / 1 failed**；唯一失败是上述 missing-dir pane 保护。修复后完整重跑两套原验收套件和 `restart-worker-null-reattach`、`restart-status-card-lifecycle`，结果为 **920 passed / 0 failed / 3 skipped，退出码 0**。随后补验 `chatMode: group` 接受、`normal` 拒绝及 group / restart 边界，定向结果为 **15 passed / 0 failed**，其余 465 例由 `-t` 筛选。

```bash
env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/dashboard-ipc.test.ts test/session-lifecycle-start.test.ts \
  test/restart-worker-null-reattach.test.ts test/restart-status-card-lifecycle.test.ts
```

扩大到共享 restart 调用方的 8 文件检查为 **80 passed / 22 failed**。22 个失败全部在“当前其余源码 + 未修改的 `HEAD:src/core/worker-pool.ts`”隔离对照中复现，没有本次新增的失败身份。对照的两套结果为 **13 passed / 23 failed**；额外那一例 shared-adopt pin launch 已随本次 effort 解析修复而通过。该局部对照只证明 worker-pool 改动未新增这 22 例失败，不等同于完整合并前基线。

| 扩展检查中仍失败的套件 | 数量 | 具体行为与下一轮入口 |
|---|---:|---|
| `test/model-pin-effort.test.ts` | 14 | 实际 `/effort` 设置后 pin 仍为 high；native receipt、SQLite 回滚、等待期间 pin clear / replace / restart 并发保护未达到测试契约。需处理 effort 写入与 receipt 接线，不是本次两例启动读取的验收范围。 |
| `test/restart-live-worker-startup-commands.test.ts` | 8 | `latestLaunchCommandsForRespawn` 未导出；restart IPC 没有携带当前 startup commands。需单独补运行中命令更新契约，本次没有修改这些测试或实现。 |

两套完整回归中的 3 个预设跳过项为：

- `PUT /api/bot-read-isolation — refuses read-isolation enable before persistence while a write-only pane can survive restart`
- `PUT /api/bot-agent Codex profile selection (#2036) — scans, searches, saves, refreshes and clears profiles through real browser controls`
- `PUT /api/bot-agent custom wrapper preservation (#2022) — saves and explicitly replaces a wrapper through real browser controls`

另一次扩展检查 `tmux-pipe-streaming.integration` 得到 **10 passed / 11 failed**。11 例在新 CLI 创建前被 anti-fork gate 拒绝：夹具的 PATH shim 隐含选择 private `-S` socket，但 gate 按 backend 的默认 socket 检查，遇到宿主上仍存活、不可达的默认 listener。这些用例没有进入其 stream 断言，不作为本次输出修复的通过证据；后续需让夹具和 backend 显式使用同一 private server 目标再验。没有关闭 anti-fork gate 或操作宿主 listener。这项扩展检查及上述 22 例均不属于 §8.5 指定的原 25 个失败。

### 9.3 PTY 与隔离运行

首次 fresh worker 复跑仍为 **6 passed / 3 failed**。Claude 日志已确认启动 in-pane relay，但 fake CLI 没有收到输入，pane leaf 仍为 `zsh`。所以旧 dist / source relay 不可运行不能解释全部失败。

进一步在失败时只读捕获测试的 private pane，画面明确停在 **`zsh-newuser-install` 首次配置向导**，要求输入 `(q)/(0)/(1)/(2)`；`pane_start_command` 显示 `zsh -l -i -c '. "$1"'` 尚未执行 launch file。临时 HOME 没有任何 zsh startup 文件，是这个交互前置条件的触发原因。两份夹具现写入一份空 `.zshrc`，不改宿主 shell 配置、不跳过 worker / CLI 的 readiness gate，也不放宽任何提交次数或 lock-card 断言。

补齐 `.zshrc` 后，默认源码与 fresh worker 均为 **7 passed / 2 failed**：Claude 延迟 SessionStart 的提交次数断言已通过；TraeX 的 session id 已正常发布，剩余两例继续定位输出订阅时序。

新增 `TmuxPipeBackend.onData` 回归先实际跑红：FIFO 在首次监听前收到包含 `OSC 7501 idle` 的输出，后注册的 listener 只收到 `live`，启动内容丢失。现复用现有 bounded raw tail，在首次 listener 注册时回放一次；最多 4096 个 UTF-16 code units。回归同时检查启动内容先于 live、第二个 listener 不重复收启动内容，保留已有多字节字符重组和实时 stream 检查。

回放后仍有两例失败。对独立产物插桩，分别记录 FIFO 数据、listener 注册、worker 回调和 parser，确认回调未被 runtime fence 丢弃。首次输入场景在订阅时 `recentOutput` 长度为 0；锁定页场景只收到后续小块，没有启动的 OSC 和锁定页主体。原因是 `createDetachedSession` 先启动 CLI、执行多次 options 查询，随后才创建 FIFO 和订阅 `pipe-pane`；假 CLI 的 200 / 500ms 重画和 800ms idle 已在这个窗口输出。

新建 pane 的 launch file 现使用随机 channel 的 `tmux wait-for`，待输出管道订阅成功后再释放 CLI。采用 tmux 已有的信号缓存语义，不增加 sleep、轮询或配置；reattach / adopt 不经过此等待。管道拒绝时不释放 CLI，释放失败时沿原错误路径回收 FIFO reader。新增顺序及失败路径回归，其中顺序用例在修复前实际失败。

修复后锁定页已能被识别；首次输入场景的运行证据确认 `OSC 7501 idle` 已完整解析。另发现夹具把 worker / shell / backend 启动开销计入 10 秒 readiness 预算，而生产 15 秒 soft timeout 在 backend 启动完成后才设定。夹具现先等待假 CLI 写入 PID 文件，再进入场景；10 秒首次输入期限、两轮恰好提交一次、旧版本 / 缺报告不得释放以及锁卡不得发布 ready 等断言均保留。

输出链路的完整单元回归为 **355 passed / 0 failed / 0 skipped**：`tmux-pipe-backend` 168、`program-status-codex-traex` 50、`program-status-parser` 23、`idle-detector` 114，退出码 0。

最终默认源码入口的两套真实 worker 验收为 **9 passed / 0 failed / 0 skipped**，原 3 个 PTY 失败清零。场景涵盖 PTY / tmux 的新版启动 idle、旧版忽略报告、缺报告保持等待、锁定页保持锁卡，以及 Claude 延迟 SessionStart 后正确提交。

两份 PTY 测试另增加 `BOTMUX_TEST_WORKER_JS` 测试入口，用于明确指定本次隔离构建的 emitted worker，避免误选运行中的旧 dist；默认源码入口和原有 binary 入口保留。分别验证默认入口与 fresh artifact，区分 shell 前置问题和构建形态。

在完成 fresh build 的隔离副本中执行：

```bash
env PATH="/tmp/bun144/bun-linux-x64:$PATH" \
  BOTMUX_TEST_WORKER_JS="/tmp/botmux-acceptance-20261114-build/dist/worker.js" \
  node node_modules/vitest/vitest.mjs run --project unit --pool=threads \
  test/worker-traex-program-status.integration.test.ts \
  test/worker-claude-late-session-start-submit.integration.test.ts
```

最终新构建入口同样为 **9 passed / 0 failed / 0 skipped**。原 3 个 PTY 失败在源码与新产物上均已清零。最终隔离副本同时执行这两套 worker 测试和两套 credential-only 测试，合计 **14 passed / 0 failed / 15 skipped，success:true**；跳过项单独计数，不列为通过。

隔离运行仍使用生产 `probeHostCredentialIsolationMechanism()`，未 mock probe、放宽 `canRun` 或移除断言。实际回读为 `supported:false / mechanism:null`，reason 为 bubblewrap 无法建立所需 namespaces / devices；工具同时报告 `/dev/fuse` 被命令沙箱限制。这是当前验收环境的阻塞，不能据 suite 退出码 0 把跳过项计为通过。

fresh CLI 复跑结果仍为 **5 passed / 0 failed / 15 skipped**，退出码 0。其中 `credential-only-dispatch-flow.integration` 10 例全部跳过，`credential-only-send-authority` 5 例通过、5 例跳过。未执行的具体场景为：

- dispatch：new topic、append / standby activation、standby、delegated schedule、handoff append、managed cross-bot dispatch；混合 direct-only 参数拒绝；seed 注册后 origin rotation；`/repo` prime 前 origin rotation；relay-only pane 对 `--bot` 拒绝、对 `--bot-app` 放行。
- send：无 relay outbox 的原缺陷复现；带 outbox 后 locator 准入；隐藏 sibling outbox；default tmux 只向 owning pane 注入 relay；warm reattach 后新 capability 进入已有 CLI。

剩余 15 例需在实际允许 bubblewrap 建立 namespaces / devices 的验收环境复跑。当前工具明确限制 `/dev/fuse`；仅放行文件访问是否足够还需重新执行生产 probe，不能提前保证通过。

### 9.4 构建、工作区与交付边界

使用 `/tmp` 下的独立源码副本、已有 `node_modules` 和 Bun 1.4.4，显式执行 package build 各阶段；不安装依赖、不覆盖 live dist、不重启 fleet。构建与 TypeScript 检查使用本机已有 TypeScript 5.9 fallback，未冒充缺失的 TypeScript 7 原生编译器验证。

最终隔离构建的 emit、`tsconfig.typecheck.json`、dashboard bundle、dist audit 与 embedded-assets audit 均通过，退出码 0；public-domain audit 也通过。runtime build id 为 `e17e38d16e58d516fc052abbb792c3f98aca52534a1030dc306d453d17f0b665`。构建副本的 `worker.ts`、`worker-pool.ts`、`dashboard-ipc-server.ts`、`tmux-pipe-backend.ts` 及最终 TraeX 夹具 SHA-256 与本工作区一致；临时插桩已由正式构建移除。这份产物用于验收，不是生产版本。

live `dist/cli.js` 和 `dist/worker.js` 在本次构建及测试后回读，仍分别为 §8.4 记录的 `7d10e09e…`、`22fe017a…`，未被验收产物替换。

本次源码、测试和报告仍为未提交改动。五份 stash、原有未跟踪稿和 `/tmp/head-wt` 保留。整树历史红项、预设跳过项与 live 发布手测没有被本次定向结果覆盖。

摘录最终结果后，已清理本轮 `/tmp/botmux-acceptance-20261114-*` 的两份构建 / 基线副本及 49 个临时结果文件；保留复用的 `/tmp/bun144` 和原有 `/tmp/head-wt`。最终 `git diff --check` 通过；live 两份产物 SHA-256 仍与 §8.4 一致，五份 stash 均保留。没有创建提交、push、部署或重启服务。
