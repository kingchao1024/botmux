# BotMux 遗留收口设计

## 背景与目标

BotMux 生产版本 `fdefb9030f3085b0c414708690e3f5d294058d32` 已通过生产验证。本批次不改 live runtime，目标是清理项目板和代码中的剩余遗留，同时保留历史失败事实。

收口对象固定为：

- reviewer replacement 的三个 P2：审计截断后旧请求重放失去幂等、投影失败后的精确重试不再投影、worker allowlist 与换绑提交存在策略竞态；
- 当前 `master` 上可复现的 baseline-known 测试失败；
- 九条历史 `failed` workstream 的行政归档；
- abandoned TaskControl canary 与父 completion gate 的受支持收口；
- 项目板、白板、在线文档和 Meego 的最终一致性。

## 约束与不做项

- 以 `origin/master=fdefb9030` 为基线，在独立 worktree 开发。
- 不在 worktree 执行 install，不修改依赖或 lockfile。
- 不把 `failed` 改写成 `completed`，不删除历史 workstream、review、receipt、canary tombstone 或 gate 记录。
- 不直接修改 `/root/.botmux/data/project-groups.json`、SQLite、session store、schedule sidecar 或 canary tombstone。
- 设计、实现和离线验证不包含 commit、push、merge、全局 CLI 认领、重启、部署或生产配置；这些动作分别申请授权。
- 五个项目群的十条巡检和小时汇报任务保持手动暂停，本批次不自动恢复。

## 批次划分

### 批次 A：reviewer replacement 与归档语义

这一批只修改 project control plane，按四个独立 RED→GREEN 行为切片推进。

#### 永久幂等收据

`reviewerReplacements` 继续只保留最近 32 条完整审计记录。新增紧凑、持久的 replacement receipt，按稳定 operation fingerprint 记录请求身份和原提交 revision。receipt 不受审计窗口截断影响，旧请求在后续 reviewer 已再次变化时仍返回幂等成功，不重写当前绑定、不增加 project revision。

operation fingerprint 必须覆盖：chat、dispatchRoot、old/new reviewer、authorizationRef、authorized actor、reason、coordinator session 和 expected revision。服务端生成时间不得参与 fingerprint。

#### 投影重试

精确 reviewer replacement 重试即使没有新的 durable mutation，也必须再次调用 project card projection。投影失败仍返回 durable success 和 `projectionWarning`，project revision 不增加。重复投影是对当前 durable project 的幂等刷新，不保存第二套业务状态。

#### 策略竞态

reviewer allowlist 不再信任 Dashboard 路由提前注入的数组。`runReviewerReplacement` 在已有 chat-scoped control-plane lock 内重新读取 collaboration mode，并从当前 `workerAppIds` 派生允许集合；collaboration mode 写入使用同一外层锁，因此策略撤销与 reviewer replacement 只能有一个先提交。项目锁仍负责 revision CAS 和 reviewer 数组原子替换。

锁顺序固定为：chat-scoped control-plane lock → collaboration mode 只读快照 → project store lock。不得新增进程内锁作为跨进程正确性边界。

#### 历史 failed 归档

`ProjectWorkstreamStatus` 新增终态 `cancelled`。归档只允许 `failed` workstream，并把当前 lifecycle status 改为 `cancelled`；同时写入 `archivedFromStatus: failed`、`archivedAt`、`archiveReason`、`archiveAuthorizationRef`、`archivedByOpenId`。原 progress、delivery、review、blocker、失败报告和时间线全部保留，因此归档不会伪装成完成，也不会抹掉失败事实。

新增命令：

```text
botmux project workstream archive --root <om_xxx> --expected-revision <n> --authorization-ref <om_xxx> --reason <text>
```

daemon 必须校验当前真人发出的精确 canonical action summary，再注入 actor。归档在 project store 锁内执行 revision CAS；精确重试幂等。项目卡、remaining 默认统计和管理层 open workstream 口径把 `cancelled` 视为终态；完成门只接受 `completed/100`，因此指向归档 workstream 的 gate 仍需单独 retire 或 replace。

## 批次 B：baseline-known 测试失败

在未修改生产代码前，使用当前 `master` 和固定父基线分别运行同一测试命令，记录测试名、退出码、耗时、tmux/socket 隔离方式和原始日志。

处理规则：

- 若当前与基线都失败，先最小化到产品逻辑或 harness；只有证据证明缺陷层级后才修改对应层。
- 不通过增加 timeout、无条件 retry、跳测或放宽断言获得绿色结果。
- 产品缺陷走独立 RED→GREEN；harness 缺陷保留产品行为不变，并用独立 socket、确定性事件或显式完成信号修复。
- 宿主能力确实不可满足时，输出机械可复算的环境边界；该项不能写成测试 PASS，但可以从代码遗留中关闭。

批次 B 不与批次 A 同时写同一工作树。批次 A 完成后再冻结新的候选身份并开始批次 B。

## 批次 C：canary 与 completion gate

先使用现有受支持命令处理，不新增万能清理入口：

- abandoned canary tombstone 保留；只关闭它造成的当前 blocker 投影。
- completion gate 使用精确真人 authorization prompt 执行 retire 或 replace，authorizationRef 必须等于当前真人消息 ID。
- 如果 fresh turn 下仍无法把精确消息映射为 verified actor，才把它作为独立身份映射缺陷处理，并为该失败取得 RED；禁止复用旧消息或用 host-terminal 绕过真人授权。

gate retire/replace 必须保留 fingerprint、原 gate、replacement 关系、授权消息和 actor。归档 failed workstream 不自动改变 gate。

## 批次 D：最终收口

完成以下检查后才能宣布源码 Done：

- 每个行为切片的 RED 与 GREEN；
- project-group focused suite、受影响完整 suite、baseline 对照、`tsc --noEmit`、`bun run check:agent`、`git diff --check` 和 build；
- 两轮 fresh hostile，覆盖跨进程 replacement 竞态、策略撤销、旧 operation replay、投影失败重试、归档重放和非法归档；
- 独立只读 reviewer 对固定候选身份给出 P0/P1=0 的结论；
- 候选身份包含 base commit、patch SHA-256、闭集路径和文件 SHA-256。

项目管理收口另需：

- 九条历史 failed workstream 全部通过归档命令处理，原状态和证据仍可回读；
- canary blocker 与 completion gate 使用支持的生命周期命令收口；
- BotMux 专项项目板、统一项目板、白板、在线文档和 Meego 使用同一阶段与剩余项口径；
- human-action、coordinator-action 和 TaskControl active task 均无未关闭事项。

## 失败与恢复

- 任一 CAS、策略 fingerprint、authorization prompt、投影或持久化失败都 fail closed。
- durable mutation 成功而卡片投影失败时保留 durable 结果，返回 warning；精确重试只补投影。
- 批次 A 或 B 出现 P0/P1 时，冻结当前候选并在同一工作树返修；不把局部绿色结果带入下一批。
- 未取得 commit 授权前保留未提交候选；未取得发布授权前不构建生产事务、不切换 live dist。

## 影响面

主要影响 project CLI、Dashboard IPC、project coordinator/store、项目卡投影与 project-group 测试。普通会话、非项目群、TaskControl mapping、schedule runtime 和 live daemon 行为不应改变。归档只改变项目管理统计，不改变历史执行结果或 completion gate 判定。
