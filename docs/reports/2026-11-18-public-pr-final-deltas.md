# 三个公共 PR 的最终增量同步

日期：2026-11-18。基线为本地 `master` 的 `2ff7a707c`，在分支 `integrate/pr-final-deltas-20261118` 的独立 worktree 中完成集成。

## 范围与来源

| PR | 来源提交 | 同步行为 |
| --- | --- | --- |
| #3511 | `79deea22f`、`c74668113`、`b82d4f708` | 非目录项不阻断捕获；不可读根保持三态；以每次启动的捕获 ID 隔离重放和延迟写入 |
| #3512 | `ae48234a7`、`7036e6fe5` | 反查门禁可独立验证；strict store 清单跳过非目录项，保留不可读和悬空链接的失败关闭 |
| #3514 | `20f3bd5e5`、`31e973e05`、`b772f9833` | 队列和 IPC 保留完整提示词；仅在 RPC 写入边缘省略已接受上下文；帧写出后提交轮次归属；unknown 和压缩后完整重发 |

另同步 `fa8575b3d` 的测试依赖 stub：本地已有 #3515 的 hook-trust 探测，新的 RPC engage harness 必须声明对应依赖。未整体合入公共 master。

保留本地单一原生轮次归属、可信 steer、任务续跑和身份边界。删除旧 prepared-context IPC 传递的残留字段；保留实际 RPC 写入时的技能目录 sidecar。

集成中新增一个回归用例：RPC 配置仍开启、引擎已经退场时，待发技能目录必须并回粘贴正文。旧的本地提前分支只查看配置、把目录留在无人消费的 sidecar 中；改为按实际引擎判断传输方式。

## 回归证据

先移植测试，在修复前观察到以下行为失败，再应用对应生产修改：

- 文件系统用例：`.DS_Store` 导致扫描失败；不可读会话根返回 `false`；strict store 扫描以 `ENOTDIR` 抛错。
- 两个相同输入重放用例：返回旧 native session ID，而不是当前启动的 ID。
- unknown 回执用例：下一次完整投递不能结算为 accepted。
- RPC 引擎用例：写出回调未触发；两个原生压缩通知均未上报。
- 粘贴回退用例：正文缺少待发技能目录。

独立验收另发现锁等待期间压缩、ACK 前压缩覆盖失效回执两个实际竞态，以及锁等待换代后旧引擎仍写出的函数边界缺口。复验又发现 backend 同时更换、写锁在执行 action 前拒绝时会丢掉未发首项。新增五条回归：锁内按最新回执准备文本；用压缩序号防止在途 ACK 恢复过期 accepted 回执；首轮同样受保护；锁内先核验代次；写锁拒绝时保留未发送首项及后继的 FIFO 顺序。

受影响测试及相邻提交确认测试共 12 个套件、441 项通过。命令前缀为：

```sh
node node_modules/vitest/vitest.mjs run --configLoader runner --no-cache --project unit --maxWorkers 3
```

套件：`doubao-adapter`、`session-store-sqlite`、`skill-cli-commands`、`traex-native-context`、`worker-traex-rpc-context`、`role-resolver`、`codex-rpc-engine`、`codex-app-clean-prompt`、`traex-auto-model-worker`、`worker-rpc-shutdown`、`codex-native-release-boundaries`、`submit-confirmation`。

真实 worker tmux 集成套件 `worker-codex-rpc-overlap.integration.test.ts` 的 7 项全部通过，验证原生轮次重叠、可信 steer、同线程重启去重、FIFO 最新回执、unknown 完整重发及跨线程回执。与上述套件合计 448 项通过。

夹具修正：临时 HOME 会触发 zsh 首次配置向导，因此显式使用 `/bin/sh`；配置私有 tmux 根并在 finally 清理；画面包含已初始化的模型、目录、composer 和页脚，并重绘以覆盖订阅前首帧。假 server 不写 rollout，终态补证后的后继等待预算由现有补证延迟列表加正常输入等待计算，生产门禁、超时和回收窗口均未放宽。跨线程用例以实际 RPC 帧与 PTY 输入记录验证完整重发且不重复粘贴。

独立异常验收最终 49/49 通过，已知发现归零；两轮新增异常组合各 4/4，通过真实 worker 函数、写锁、CodexRpcEngine、loopback WebSocket 和 SQLite 验证：

- 锁等待换代和压缩交叠，未发送首项保持对象身份及 FIFO；不同 attempt 不被误去重。
- 已发丢 ACK、metadata I/O 异常及重入不重复派发；新代次同键和不同 turn 的 owner、terminal 与回执不被旧 continuation 清理。
- 首轮及后续 ACK 前压缩保留 unknown；下一次完整重发角色与目录。
- SQLite 未提交、提交、回滚、坏行、目录杂项及断链组合保持身份反查失败关闭。

独立证据保留在 `/tmp/pr-final-readonly-20261118/`，复用的前轮探针在 `/tmp/pr-final-reverify-20261118/`。旧剩余 23 项输出完整通过结果后，工具包装器以 255 退出；这是已记录的执行环境限制，不冒充全部命令退出码为 0。

未验收真实生产 fleet 发布、原生模型服务、ZMX、多账户常驻进程、磁盘故障或 WAL 中断；换代异常在真实函数/协议边界复现，不扩大为所有生产重启时序的证明。

额外运行的 `raw-input-followup-atomicity.test.ts` 有 15 项通过、1 项失败：该基线文件引用未定义的 `caseRegion`。本次未修改该文件；失败发生在源码断言辅助函数调用处，不是所同步行为的回归。未运行整个仓库全量套件。

## 构建与交付边界

`bun run build` 在当前工具环境以 127 退出，未把它记作通过。改用系统 shell 逐项执行 `package.json` 中同一构建脚本及其嵌套脚本：Bun 版本检查、公共域名审计、全部资源生成、清理隔离 dist、编译、typecheck、构建 ID、scope 资源复制、Dashboard bundle、dist 审计、内嵌资源审计，全部通过。

编译器 Bun 为 `1.4.4`，构建 ID 为 `93f289dccf44fc87df9853e072a1f8a8b305350b636d18d590ce3ff7ba02f86f`。`python3 scripts/agent_repo_check.py` 和 `git diff --check` 通过。

主工作区仍在 `2ff7a707c`；其中的文档修正及原有 WIP 不包含在本提交中。没有推送、合入主分支、认领全局 CLI 或重启生产。
