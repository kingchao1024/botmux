# botmux 研发导航

`AGENTS.md` 是本文件的软链。这是一层按需加载的研发 overlay：保留现有 README 与 `docs/`，只阅读当前任务需要的 `docs/agent/` 叶子页，禁止整树加载。

## 开始前

1. 先写清目标、范围、验收证据和禁止项。
2. 从 [docs/agent/index.md](docs/agent/index.md) 进入，只打开相关叶子页。
3. 改动本 overlay 后先运行 `bun run check:agent`，再运行任务相关检查。

## 高风险硬约束

- 包管理器与 CI 编译器固定为 Bun `1.4.2`；`trustedDependencies` 只能保留 `electron`、`node-pty`。详见 [质量与工具链](docs/agent/quality.md)。
- 禁止在 worktree 执行 install；依赖变化只能在 worktree 外处理。详见 [质量与工具链](docs/agent/quality.md)。
- 编译态子进程必须走 `src/core/self-spawn.ts`，不得向子进程传递 `dist/` 或 `__dirname` 拼出的路径。详见 [运行可靠性](docs/agent/reliability.md)。
- build 不会认领全局 CLI，也不改变 live daemon；认领、重启和 live 手测必须另行明确授权。详见 [运行可靠性](docs/agent/reliability.md)。
- Linux 已启用 `botmux.service` 时，禁止从 BotMux/Trae 会话直接运行 fleet 启停命令；必须从会话外通过 systemd 管理。详见 [运行可靠性](docs/agent/reliability.md)。
- owner 身份按应用隔离并 fail-closed；setup/onboarding 必须复用现有身份边界。详见 [安全边界](docs/agent/security.md)。

## 交付边界

坚持最小、可逆改动；实现与独立验收分离。检查失败不得报完成。commit、push、merge、release、delete 与生产动作均需单独明确授权。

<!-- BEGIN: share-context-memory v1 -->
## 项目记忆协议

- BotMux 不依赖 Trae hooks；本管理块是跨 IDE 的项目级兜底。当前初始化命令轮不召回、不保存，也不回补旧会话。
- 从初始化成功后的下一轮普通对话开始，回答前使用已加载的 `share-context-memory` Skill 做精准召回；最多保留与当前任务直接相关的 3 条摘要，优先使用 compact 输出，不注入完整历史。
- 回答完成、实际发送前，默认按 Skill 规范以 zero-disk stdin 方式，仅保存最近 1 组 USER + ASSISTANT 到 personal；失败静默，不阻断主任务。
- 个人记忆身份必须优先取当前消息发件人的字节邮箱前缀；仓库由 `root` 等系统账户运行时，不得把系统用户名当作真人身份。无法可靠解析时，静默跳过该轮保存。
- `/som`、`/save-mem` 仅在用户明确输入时写入 org；任何自动流程都禁止上传组织记忆。`/spm`、`/save-personal` 只按用户明确范围回补 personal。
- 需要回忆历史决定、用户偏好、团队规则或变更原因时，必须先精准搜索 memory，再按需退化到代码检索、联网搜索或询问用户。当前消息与记忆冲突时，以当前消息为准。
- 原始旧 BotMux 会话继续作为证据保留，不自动导入。只有用户明确指定时才回补，并只提取长期约束、最终决定、项目状态、验证结论和未完成事项。
- 稳定项目知识应写入仓库文档；个人记忆用于跨会话连续性，不能替代代码、测试、规格和验收证据。
<!-- END: share-context-memory v1 -->
