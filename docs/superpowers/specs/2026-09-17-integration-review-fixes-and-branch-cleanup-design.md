# 集成复核问题修复与分支清理设计

## 目标

修复集成分支复核发现的四项问题，完成验证并提交；随后删除已经被集成分支完整包含、没有有效 worktree、也不承载未提交工作的冗余本地分支。

当前修复分支仍为 `integrate/all-local-branches-20260916`。不删除远端分支，不推送，不打 tag。修复验证完成后，按仓库规定重新构建并重启当前 live daemon。

## 远端语义

- `origin` 是本仓库优先同步和 rebase 的上游。
- `upstream` 是 fork 对应的主仓库参考，不作为 overlay 更新脚本的默认 rebase 目标。
- `scripts/update-local-overlay.sh` 继续执行 `git fetch origin master --tags` 和 `git rebase origin/master`。
- `LOCAL_OVERLAY.md` 删除写反的远端说明、失效的 `codebase` remote 指令和私人账号标识，改成与当前仓库语义一致的中性说明。

## 四项修复

### Reviewer 测试时间

生产规则保持不变：ReviewerVerdict 从飞书来源消息创建时间起有效 24 小时。测试通过可控时钟运行，让固定消息时间与验证时钟处于同一有效窗口；另保留独立过期用例，避免用放宽过期校验换取测试通过。

### Overlay Bun 版本

`scripts/update-local-overlay.sh` 不再写死 `bun@1.4.0`。脚本从 `package.json` 的 `packageManager` 读取完整 Bun 版本，并拒绝缺失或格式异常的值。测试、构建和单文件二进制编译均使用这一个版本。

### 非空 daemon smoke 的失败清理

`scripts/smoke-bun-daemon-nonempty.mjs` 把子进程启动错误纳入正常 Promise 错误路径，保证 `ENOENT`、`EACCES`、非可执行文件等失败不会触发未处理的 `error` 事件。临时目录清理由顶层 `finally` 覆盖，启动失败、健康检查失败和正常完成都必须清理。诊断继续使用稳定的 `smoke: FAIL [nonempty-daemon] ...` 格式。

### Overlay 文档

同步修正 `LOCAL_OVERLAY.md`：明确 `origin` 是优先同步源，`upstream` 只是 fork 主仓库参考；移除不存在的 `codebase` remote 和私人账号。发布仍由操作者显式执行，不由更新脚本自动 push。

## 测试策略

按 TDD 分三条行为缝推进：

1. Reviewer 路由测试先证明固定日期在真实当前时钟下失败，再注入受控时钟并验证首次提交、幂等重放和过期拒绝。
2. Overlay 脚本增加只读自检入口或可独立测试的版本解析，先证明写死版本和文档远端契约不符合预期，再改为读取 `packageManager`。
3. 非空 daemon smoke 先用不可执行文件复现未处理异常和临时目录残留，再修复 spawn 错误处理和顶层清理。

完成后执行相关聚焦测试、全部变更测试、`bun run build`、`git diff --check`，并用两类不同坏输入复验 smoke 清理。

## 分支清理

先运行 `git worktree prune --dry-run` 并核对每个候选分支满足以下条件：

- 是当前集成 HEAD 的祖先；
- 不等于 `master` 或当前集成分支；
- 没有有效 worktree；
- 不承载未提交工作；
- 只删除本地引用。

清除失效 worktree 元数据后，使用 `git branch -d` 删除满足条件的分支。`feat/p2-task-control-plane` 因原工作区仍在使用且有九个未提交文件，必须保留。预计删除的冗余分支为：

- `backup/pre-integrated-candidate-apply-20260908-0845`
- `backup/pre-upstream-rebase-20260908-0615`
- `feat/p3-task-control-production`
- `fix/botmux-post-upgrade-p1`
- `fix/bots-lock-observability`
- `fix/restart-stop-barrier`
- `fix/send-top-level-intent-guard`
- `fix/stability-followups`
- `fix/traex-rpc-hook-trust`
- `fix/workflow-new-run-birth`
- `integrate/v3193-s1-control`
- `local/h4-write-grant-release`
- `local/p3-default-off-candidate`
- `local/p3-overlay-106b328a`
- `local/s1-overlay`

最终删除数量以执行前重新核验结果为准；任何仍被有效 worktree 占用或不再是集成 HEAD 祖先的分支都会自动跳过。

## 部署边界

代码修复、提交和验证通过后执行 `bun run switch:here && bun run daemon:restart`，让 live daemon 使用修复后的集成 HEAD。验证 supervisor、全部 Bot、Dashboard HTTP 和新启动日志。不会推送 Git、打 tag 或发布 npm。
