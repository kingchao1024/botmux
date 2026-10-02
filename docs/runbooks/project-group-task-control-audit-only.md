# Project Group TaskControl audit-only 运行手册

## 适用范围

本手册用于把一个全新的 project-group write workstream 接入 daemon TaskControl 的 audit-only 账本。项目卡和 project store 仍按原路径更新；TaskControl 只记录可信 mapping、生命周期事件和 audit diff。

这套配置不会启用 controlled writeback、outbox pump 或 freeze enforcement，也不会迁移历史任务。Android 的 78 条历史 workstream 和插件 TaskControl 中的 26 条 FAILED 记录只做 reconcile 或归档，不导入 daemon TaskControl。

## 授权门

修改 live 配置、认领全局 CLI、重启 daemon 和启用 canary 都要单独授权。仅完成代码、测试或 build，不代表可以执行这些动作。

开始维护窗前记录以下内容：

- 当前 checkout、分支和构建产物 SHA-256。
- `group-collaboration-modes.json`、`project-groups.json` 和 `botmux-task-control-plane.sqlite` 的备份路径、SHA-256、权限及属主。
- canary 群的 `chatId`、controller、worker、reviewer 和 acceptor app id。
- 回滚负责人、验证命令和可接受的维护时长。

## 仓库内维护入口

TaskControl canary 生命周期只能通过仓库内脚本调用 daemon 的 host-authenticated IPC。脚本不属于已安装的公共 `botmux` CLI，也不得把它注册成公共命令：

```text
绝对路径：/data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs
SHA-256：07f23ff8bbf27397b2353f50c27157f067f47c1564ece40a17776bcc608e1360
```

维护前必须在受审 checkout 中重新计算 SHA-256，并与上面的固定值逐字节一致；不一致就停止。脚本只从当前 BotMux 进程上下文加载 managed session id、daemon app 和 IPC port。命令行不得传入或覆盖 session、app、chat 或 root，也不得直接 import store、手改 JSON/SQLite，或调用 daemon route 绕过该脚本。

下面列出脚本接受的全部 argv。尖括号字段必须在执行前替换成经复核的字面量，并把替换后的整行命令纳入 live plan；禁止使用环境变量、命令替换、glob、`pwd`、`git rev-parse`、`jq` 或其它 shell-derived default 生成任何参数。

```bash
bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs status

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs prepare --authorization-ref <om_current_human_authorization> --plan-sha256 <64_lowercase_hex> --dispatch-spec </absolute/reviewed/dispatch-spec.json>

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs enable --fence-fingerprint <tccq1:64_lowercase_hex> --expected-config-hash <pgc1:64_lowercase_hex>

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs phase-a-send --fence-fingerprint <tccq1:64_lowercase_hex> --instruction-template-sha256 <64_lowercase_hex>

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs disable --fence-fingerprint <tccq1:64_lowercase_hex> --expected-config-hash <pgc1:64_lowercase_hex>

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs clear --fence-fingerprint <tccq1:64_lowercase_hex> --cleanup-state pre_dispatch_abort

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs clear --fence-fingerprint <tccq1:64_lowercase_hex> --cleanup-state phase_a_terminal_no_canary

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs clear --fence-fingerprint <tccq1:64_lowercase_hex> --cleanup-state delivered_terminal --success-certificate-hash <tcsc1:64_lowercase_hex>

bun /data00/home/root/workspaces/botmux-upstream/scripts/task-control-canary-operation.mjs abandon --authorization-ref <om_current_human_abandonment_authorization> --fence-fingerprint <tccq1:64_lowercase_hex> --expected-config-hash <pgc1:64_lowercase_hex>
```

`prepare` 和 `abandon` 还要求当前顶层真人消息与 canonical prompt 完全一致。`prepare` 的 JSON 字段顺序固定为 `action`、`planSha256`、`dispatchSpec`；`abandon` 固定为 `action`、`fenceFingerprint`、`expectedConfigHash`。授权消息必须来自当前 session owner 或通过 open-id `canOperate` 的真人，且必须与当前 app、chat、session 和 managed origin 完全匹配；旧消息、bot、schedule、union-id 或请求体自报身份都不能授权。

```text
授权执行 BotMux TaskControl canary 操作：{"action":"prepare_task_control_canary","planSha256":"<64_lowercase_hex>","dispatchSpec":<exact_canonical_dispatch_spec_json>}

授权执行 BotMux TaskControl canary 操作：{"action":"abandon_task_control_canary","fenceFingerprint":"<tccq1:64_lowercase_hex>","expectedConfigHash":"<pgc1:64_lowercase_hex>"}
```

严格按 `status → prepare → enable → phase-a-send` 执行，并逐次从上一条 JSON 响应人工复制 `fenceFingerprint`、`configPreimageHash` 或 `configHash`。Phase A 成功后才执行下文与 fence 完全一致的 `botmux dispatch --task-control audit-only`。正常结束先 `disable`，再以持久化 success certificate 的 hash 执行 `clear --cleanup-state delivered_terminal`。只有没有 Phase A 尝试时才能使用 `pre_dispatch_abort`；只有冻结的 Phase A 终态证据齐全且没有 Phase B 痕迹时才能使用 `phase_a_terminal_no_canary`。

其余残留状态不得自动 clear。必须取得一条新的、仍为当前回合的真人 `abandon` 授权，再执行上面的完整 abandon argv。该动作允许从 enabled、disabled-with-fence 或 already-abandoned 状态幂等恢复，但只会关闭 audit-only 并把 live fence 转成 durable tombstone；它不会删除 root、reservation、event、report 或 evidence，也不代表验收通过。之后用 `status` 只读确认返回的 `abandoned` 记录和 fingerprint；若仍无法排除晚到活动，保持隔离，不安装下一轮 fence。

## audit-only 启动条件

controller、worker 和 reviewer daemon 必须使用同一份 host secret，并设置下面的进程级开关：

```bash
TASK_CONTROL_PLANE_PRODUCTION=true
TASK_CONTROL_PLANE_LEDGER_ENABLED=true
TASK_CONTROL_PLANE_SHADOW_ENABLED=false
TASK_CONTROL_PLANE_PUMP_ENABLED=false
TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT=false
```

对应群必须保持 `mode=project`，并配置精确的 audit-only 策略：

```json
{
  "mode": "project",
  "coordinatorAppId": "cli_controller",
  "workerAppIds": ["cli_worker", "cli_reviewer", "cli_acceptor"],
  "taskControlPlane": {
    "mode": "audit_only",
    "acceptorAppId": "cli_acceptor",
    "maxActiveMappings": 1
  }
}
```

四个角色必须互不相同。worker、reviewer 和 acceptor 都要在该群的 worker allowlist 中；一次 canary 只允许一个未终态 mapping。其它项目群即使由同一 controller daemon 服务，也不会因进程级 ledger 开关自动纳管。

容量判断以 controller TaskControl SQLite 的不可变事件链为准，不以 project workstream 的 `completed`/`failed` 文案或最新投影状态代替。只有两种事实释放容量：mapped worker 的合法 `task.failed` 必须绑定 exact project report、reporter/source 和 `project_report_failed`；成功终态必须绑定同轮独立 PASS、controller first-ingress 时间、同一 reviewer evidence 的 reviewed/delivered/done、`terminal=true`、exact artifact/destination，以及 delivered outbox 和 receipt。FAIL、CONDITIONAL、UNKNOWN、缺 receipt/done、wrong role/source，或 `cancelled` 都不释放容量。

容量释放和新 reservation admission 是两个独立判定。合法终态后的 UNKNOWN、冲突、verdict/key 撤销或其它 terminal audit defect 不会反转既有容量事实，但会让 `admissionSafe=false`，因此仍不得创建下一条 mapping。历史 pre-terminal、非终态 transition violation 保留在 blocked 审计投影中；它不会单独抹掉已证明的容量终态。任何 terminal-shaped violation，以及 release event 之后的 transition violation，都阻断下一次 admission。reservation 必须在同一项目锁内同时满足 `capacityReleased=true` 和 `admissionSafe=true`。

若配置 `TASK_CONTROL_PLANE_ALLOWED_KEY_IDS` 或 `TASK_CONTROL_PLANE_REVOKED_KEY_IDS`，列表必须覆盖本次启用的 mapping、reservation、worker evidence、reviewer evidence、ReviewerVerdict、DesignatedReviewer 和 delivery receipt key id。缺少任一用途的当前 key，相关动作都会 fail-closed。

## 创建 canary workstream

只为全新 write workstream 显式请求 audit-only：

```bash
botmux dispatch \
  --title "<24 字以内标题>" \
  --bot-app "<worker_app_id>:worker" \
  --bot-app "<reviewer_app_id>:reviewer" \
  --write-scope "<绝对路径>" \
  --task-control audit-only \
  --brief-file "<简报文件>"
```

未传 `--task-control audit-only` 的 workstream 继续走 legacy。显式请求后，只要角色、scope、群配置、root 回读或 runtime flag 有一项不满足，dispatch 就会返回结构化错误，不能静默降级。

## 只读核验

先确认数据库 schema 为 14，再按 app 和 root 查看 mapping、事件及回执。下面的查询不修改数据库：

```bash
sqlite3 -readonly /root/.botmux/data/botmux-task-control-plane.sqlite \
  'PRAGMA user_version;'

sqlite3 -readonly -header -column /root/.botmux/data/botmux-task-control-plane.sqlite \
  "SELECT lark_app_id,dispatch_root,task_guid,project_id,phase_id,owner_id,reviewer_id,acceptor_id,mapping_authority_json,created_at
   FROM control_trusted_mappings
   WHERE dispatch_root='<om_root>';"

sqlite3 -readonly -header -column /root/.botmux/data/botmux-task-control-plane.sqlite \
  "SELECT seq,event_id,event_type,actor_role,source_ref,evidence_ref,error_class,terminal,occurred_at
   FROM control_events
   WHERE task_guid='<task_guid>'
   ORDER BY seq;"

sqlite3 -readonly -header -column /root/.botmux/data/botmux-task-control-plane.sqlite \
  "SELECT event_id,destination_id,status,attempts,last_error,updated_at
   FROM control_outbox
   WHERE event_id IN (SELECT event_id FROM control_events WHERE task_guid='<task_guid>')
   ORDER BY updated_at;"

sqlite3 -readonly -header -column /root/.botmux/data/botmux-task-control-plane.sqlite \
  "SELECT source_app_id,evidence_id,controller_app_id,canonical_hash,created_at
   FROM control_project_worker_evidence
   ORDER BY created_at;"
```

正常事件链为：

```text
mapping.registered
→ task.dispatch_requested
→ task.accepted
→ task.execution_started
→ task.first_submitted
→ task.reviewed
→ task.delivered
→ task.done_marked
```

`task.delivered` 必须有同一 event 和 destination 的 delivered receipt。review PASS 还要绑定当前 reviewer、当前 round、稳定 trigger receipt 和 project revision。项目卡显示“完成”只能作为 legacy 投影，不能替代这些证据。

TaskControl-managed worker 使用结构化 `botmux report --status failed` 时，report relay 必须先完成 project CAS，再生成签名 `failed_report` evidence，由 controller 写入 `task.failed`。project CAS 失败时只写 UNKNOWN，不制造终态；report 与 turn terminal 乱序或重放时只保留一个 `task.failed`。项目侧已有 delivery/review 继续保留作审计，不能用失败回报清除。新的 audit-only dispatch 只有在该 `task.failed` 可从 SQLite 投影回读后才会释放容量。

## audit diff 的处理

| code | 含义 | 处理 |
| --- | --- | --- |
| `legacy_only` | project 有 workstream，TaskControl 没有纳管引用 | 历史任务允许保留；新 canary 需检查 dispatch intent |
| `task_control_only` | SQLite 有 mapping，project 找不到对应 root | 停止放量，核对项目文件和 root |
| `state_mismatch` | legacy 状态与事件投影不一致 | Phase 1 只记录，不回写项目卡 |
| `missing_mapping` | project binding 与可信 mapping 缺失或不一致 | 保留 `mapping_pending`，只允许按原 canonical facts 重试 |
| `unresolved_unknown` | 存在未解决的 required UNKNOWN | 不得宣布完成，补齐可信证据 |
| `transition_violation` | 事件不满足合法状态转换 | 保留审计；terminal-shaped 或 post-terminal violation 阻断新 admission，任何 violation 都使 success certificate 不成立 |
| `terminal_without_receipt` | 有 terminal event，但没有对应 delivered receipt | 不得视为已交付 |
| `stale_execution_without_terminal` | execution 超时且没有可信 terminal | 写 `unknown.required`，不得直接写 failed |

reconciler 只允许恢复同一个 dispatch：`reserved` 在两分钟 reservation TTL 内用同一 provider UUID 重放已签名 seed；`root_created` 可重建缺失 registry 并提交原 workstream；`mapping_pending` 可按原 proof 和 canonical facts 补 mapping。它还会幂等补齐缺失的 `task.dispatch_requested`、`task.acceptance_timed_out` 和 execution timeout 的 `unknown.required`。canonical facts 不一致时保持冲突，不创建新的逻辑 root 或 taskGuid。

## 跨群父级完成门

跨群目标不能用单个 chat 的 project 状态判断整体完成。父级主控在拿到子群的精确 root 和 taskGuid 后登记 completion gate：

```bash
botmux project gate add \
  --id <gate-id> \
  --source-chat-id <oc_xxx> \
  --dispatch-root <om_xxx> \
  --task-guid <uuid> \
  --label <名称>
```

`botmux project gate status` 查看当前 gate。daemon 会沿用现有 audit 周期核对 source project 与 TaskControl ledger。只有 workstream completed/100、同轮 PASS review、active exact ReviewerVerdict、terminal、delivered receipt 和该 root 的空 audit diff 同时成立时，gate 才进入 `satisfied`。通过投影有效 5 分钟，剩余不超过 1 分钟时才刷新；相同结果不会每 15 秒重写 project store。

取消或替换必需依赖时，先用 `botmux project gate status` 读取当前 `definitionFingerprint`。然后让有操作权限的真人在同一项目群发出精确的 canonical action summary；只有该消息仍是当前活动回合时才能执行，不能复用旧消息，也不能只回复“授权”。retire 的授权正文格式如下：

```text
授权执行 BotMux completion gate 变更：{"action":"retire_completion_gate","gateId":"<旧 gate-id>","expectedDefinitionFingerprint":"<pcg1:...>","reason":"<原因>"}
```

replace 使用同一前缀，JSON 依次包含 `action`、`gateId`、`expectedDefinitionFingerprint`、`newGateId`、`sourceChatId`、`dispatchRoot`、`taskGuid`、`label`、`reason`。收到该消息后，把它的 `om_...` message ID 作为 `--authorization-ref`：

```bash
botmux project gate retire \
  --id <gate-id> \
  --expected-fingerprint <pcg1:...> \
  --authorization-ref <om_xxx> \
  --reason <原因>

botmux project gate replace \
  --id <旧-gate-id> \
  --expected-fingerprint <pcg1:...> \
  --new-id <新-gate-id> \
  --source-chat-id <oc_xxx> \
  --dispatch-root <om_xxx> \
  --task-guid <uuid> \
  --label <名称> \
  --authorization-ref <om_xxx> \
  --reason <原因>
```

`retire` 保留原 gate 的定义、最后评估和退役审计，只让它停止参与完成判定。`replace` 在同一个 project store 文件锁内退役旧 gate 并追加新 pending gate。daemon 会校验当前 turn、真人身份、同 app、owner/`canOperate` 的 open-id 权限腿和完整动作摘要，再注入并持久化 `authorizedByOpenId`；请求体自带身份不会被采用，真人 union_id 也不会进入 team-bot/platform-bot 权限腿。完全相同的重试不改 revision 或 JSON inode；fingerprint、授权引用、授权人、原因或替代定义漂移时拒绝。禁止直接编辑 `project-groups.json` 删除或改写 gate。

只要任一 gate 为 `pending`、`blocked` 或评估已过期，父级 `progress=100` 和 `project close` 都返回 `project_completion_gates_open`。这两个 terminal 操作还会在 project store 锁内读取 source project，并通过当前 TaskControl verifier 同步重验，持久化旧状态不能单独放行。`--clear-blockers` 不删除 gate。当前回复结束也不改变 gate；等待外部群授权时，父级项目保持 active，授权请求仍只发事项所属群。

置顶项目卡只统计 active gate，并显示聚合数量与状态。retired gate 只保留在 `project gate status` 的审计结果中；卡片不跨群展示 source chat、root、taskGuid、内部 label、授权引用或退役原因。

## 回滚

回滚不得直接编辑配置或把 `taskControlPlane` 置为 `null`。先用仓库脚本执行 `status`，人工复制当前 `fenceFingerprint` 和 `configHash`，再执行上文完整的 `disable --fence-fingerprint ... --expected-config-hash ...` argv。只有 `pre_dispatch_abort`、`phase_a_terminal_no_canary` 或持久化 success certificate 证明的 `delivered_terminal` 才能继续执行对应 `clear`。其它残留状态必须取得当前真人的 canonical abandonment 授权，执行完整 `abandon` argv，把 live fence 原位转成 durable tombstone。

若仍需关闭 production 或 ledger flag，必须另行取得生产配置与 daemon 重启授权，并按已批准的维护流程执行；本手册中的脚本不会修改这些进程级开关。

回滚后核对 legacy dispatch、report 和项目卡更新仍正常。SQLite、project store、dispatch root、事件和 evidence 全部保留，只读归档；不得删除或改写历史记录。

## 禁止项

- 不导入既有 project workstream 或插件 TaskControl 记录。
- 不启用 shadow、pump、controlled writeback 或 freeze。
- 不把 PID、session active、进度文案或自然语言“完成”当成状态证据。
- 不从 worker 或 reviewer daemon 直接写正式事件；它们只能提交签名 evidence，由 controller daemon 验证并落账。
- 不在 BotMux 会话里直接重启已由 systemd 管理的 fleet。
- 不执行 commit、push、merge、release、删除或扩大到其它群，除非另有明确授权。

## 验收与停止条件

每个 canary 都要核对唯一 root、唯一 mapping、角色隔离、事件顺序、receipt、UNKNOWN 和项目卡不受 audit projector 改写。任一 P0/P1、跨群写入、双 mapping、插件任务新增或不可解释的 state mismatch，都应立即停止后续动作，保留现场，并按上面的 exact disable/clear 或当前真人授权的 abandonment 路径处置；不得直接改配置或删除 fence。

Phase 1 验收通过后仍停在 controlled writeback 授权门前。后续开启 pump、projector CAS 或 freeze 必须另写计划并取得授权。
