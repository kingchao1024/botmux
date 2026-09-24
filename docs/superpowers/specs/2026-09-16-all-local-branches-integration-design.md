# 本地分支全集成设计

## 目标

把当前仓库中尚未进入 `upstream/master` 的本地功能改动收敛到一个可审查、可验证的集成分支，同时保留原工作区未提交内容，不推送、不部署、不改现网。

集成基线固定为 `upstream/master@520167a7`，目标分支为 `integrate/all-local-branches-20260916`。

## 输入范围

按提交拓扑折叠重复指针、备份分支和已被后续分支包含的祖先分支后，纳入以下六个独立末端：

- `feat/p2-task-control-plane`
- `fix/bots-lock-observability`
- `fix/stability-followups`
- `fix/workflow-new-run-birth`
- `local/h4-write-grant-release`
- `local/p3-default-off-candidate`

以下名称不再单独合并：

- `integrate/v3193-s1-control` 与 `feat/p2-task-control-plane` 指向同一提交。
- `local/p3-overlay-106b328a` 与 `local/s1-overlay` 指向同一提交，且其内容已进入后续任务控制面分支。
- 两个 `backup/pre-*` 分支是同一备份提交，并已进入后续任务控制面分支。
- `fix/botmux-post-upgrade-p1`、`fix/traex-rpc-hook-trust`、`fix/restart-stop-barrier`、`fix/send-top-level-intent-guard`、`feat/p3-task-control-production` 等均已被上述某个末端包含。
- 本地 `master` 已被 `upstream/master` 包含，不产生额外改动。

## 合并方法

不按分支名机械叠加。先在隔离 worktree 中逐个合并六个末端，保留分支来源和 merge 记录；发生冲突时按功能语义处理：

1. 以上游当前接口和目录结构为底。
2. 同一功能存在多版实现时，保留约束更完整、测试覆盖更强、提交时间更晚的版本。
3. 不因解决冲突删除任一分支独有功能；若两套语义无法同时成立，记录冲突和最终选择。
4. `8182a286` 的飞书卡片回调元数据修复必须出现在最终结果中，并保留对非 SDK symbol、嵌套 symbol、错误事件类型、getter 和 Proxy 的拒绝。
5. 不修改依赖声明，不在 worktree 里执行 `bun install`。依赖复用 canonical `node_modules` 的只读符号链接。

合并顺序先处理范围较小的稳定性分支，再处理任务控制面分支，最后合并当前 P2 集成链：

1. `fix/bots-lock-observability`
2. `fix/stability-followups`
3. `local/p3-default-off-candidate`
4. `local/h4-write-grant-release`
5. `fix/workflow-new-run-birth`
6. `feat/p2-task-control-plane`

该顺序让重复实现尽早暴露，并让最新的流程与 P2 集成语义在冲突裁决时拥有最终上下文。

## 验证标准

合并完成后必须满足：

- `git status` 只包含预期合并结果，没有原工作区的未提交内容。
- 六个末端均为集成分支祖先。
- 运行真实 `Lark.EventDispatcher` 的卡片回调测试，确认 SDK 根级 `Symbol(event-type)` 可通过，异常 symbol 仍被拒绝。
- 运行各分支涉及的定向测试，至少覆盖 Ask、卡片回调、配置锁、RPC 停止、任务控制面、workflow 和 supervisor。
- 执行 `bun run build`。
- 执行完整测试；若受环境或既有失败阻塞，逐项记录命令、失败和是否由本次集成引入。
- 检查最终 diff 和提交图，确认没有丢失独有提交。

## 安全边界

- 不改 `/data00/home/root/workspaces/botmux-upstream` 当前工作区的九个未提交文件。
- 不清理现有分支、备份引用或陈旧 worktree 记录。
- 不推送任何远端。
- 不执行 `switch:here`，不重启 daemon，不部署到 live。
- 只有验证通过并再次取得明确授权后，才考虑推送或部署。

## 失败处理

如果冲突揭示两条分支对同一业务规则有不可兼容的要求，暂停该冲突，不用“能编译”替代语义判断。其余已经合并的提交保留在隔离分支，原工作区和现网保持不变。
