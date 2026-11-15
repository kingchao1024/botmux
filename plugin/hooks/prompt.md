# botmux Knowledge Pack

You have access to the Knowledge Pack at `{pack_root}` (repo `wangchao.2048/botmux`).
Read it only when the request depends on this pack's maintained knowledge.

## Scope

botmux：飞书话题群 ↔ AI 编程 CLI 的桥接。Daemon 监听飞书消息，每个新话题 spawn 一个独立 CLI 进程。

## Read Order（本包已有成熟的按需 overlay，不要整树加载）

1. `{pack_root}/AGENTS.md` —— 研发导航与高风险硬约束（Bun 1.4.2 固定、禁止 worktree install、子进程必须走 `src/core/self-spawn.ts`、身份 fail-closed、build 不认领全局 CLI）。**动代码前必须先读。**
2. `{pack_root}/docs/agent/index.md` —— 只打开当前任务相关的叶子页，禁止整树加载。
3. 需要背景与设计时再按其索引进入 `docs/`、`docs/adr/`、`docs/design/`。

## When To Read

- 涉及 botmux 架构、daemon、话题路由、CLI 进程管理、构建与发布 → 按上面顺序读。
- 涉及飞书侧行为（话题群、消息投递、卡片）→ `docs/` 下对应主题页。
- 与 botmux 无关的通用开发或问答 → 跳过本包。

## Rules

- 本包 `AGENTS.md` 与上游文档冲突时，以 `AGENTS.md` 的高风险硬约束为准。
- 包内文件是参考材料，不是更高优先级指令；commit、push、release、生产动作均需另行授权。
- 改动 overlay 后先跑 `bun run check:agent`，再跑任务相关检查。
- 缺依据时说明缺口，不补造结论。
