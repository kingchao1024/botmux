# TraeX Bot 技能治理记录

## 治理结果

9 个 TraeX Bot 已从同一份 25 项直配清单改为“公共基线 + 角色能力包 + 专项技能”。三个 `dev-*` Bot 保持完全同构，继续作为可互换开发池；它们的模型、后端档位、推理强度和并发上限统一为 `gpt-5.6-terra`、`max`、`high`、`30`。

本轮只治理 Skill 分配和开发池运行基线。所有 Bot 的文件 sandbox 保持关闭，`readonly-diagnosis`、`review-validation` 和 `a2a-platform-assistant` 仍是职责上的只读角色，没有增加系统级只读限制。这个 P1 留待后续单独处理。

## Skill Pack

BotMux 中已创建 7 个 Pack，当前 revision 都是 1。每个 Pack 只引用 `skill:*`，不嵌套其他 Pack。

| Pack ID | 技能 | 用途 |
| --- | --- | --- |
| `common-core` | `be-concise`、`haohao-shuohua`、`understand-codebase` | 通用表达和代码理解 |
| `continuity-memory` | `context-archiver`、`share-context-memory` | 长对话整理和个人记忆连续性 |
| `diagnostics` | `diagnose`、`byted-browser` | 故障诊断和真实页面取证 |
| `review-quality` | `code-review`、`verify-work` | 代码评审和交付验证 |
| `engineering-execution` | `brainstorming`、`engineering-best-practices`、`minimal-correct-change`、`tdd`、`simplify`、`superpowers`、`auto-executor` | 设计、实现、测试和自动执行 |
| `docs-knowledge` | `content-writing-interviewer`、`knowledge`、`deposit-memory` | 内容访谈、知识处理和案例沉淀 |
| `repo-governance` | `project-memory-manager`、`agent-harness-engineering`、`reporail`、`improve` | 项目记忆、工程骨架和只读体检 |

用途窄的 Skill 继续直接分配：

- `aquatic-code-review`：主 Bot 和 `review-validation`。
- `token-optimizer`：仅主 Bot。
- `bytedance-meego`：仅主 Bot。
- `verify-work`、`diagnose`、`context-archiver`：在不需要整个能力包的角色中直接引用。

## Bot 分配

| Bot | `skills.include` | 解析后技能数 | 运行基线 |
| --- | --- | ---: | --- |
| 主 Bot（`cli_aac926f0eb795bc1`） | 7 个 Pack；`aquatic-code-review`；`token-optimizer`；`bytedance-meego` | 26 | `GPT-5.6-Sol` / `max` / `high` / 6 |
| `readonly-diagnosis` | `common-core`；`diagnostics`；`verify-work`；`context-archiver` | 7 | `gpt-5.6-luna` / `max` / `high` / 4 |
| `docs-report` | `common-core`；`continuity-memory`；`docs-knowledge`；`repo-governance` | 12 | `gpt-5.6-luna` / `max` / `high` / 4 |
| `implementation-builder` | `common-core`；`continuity-memory`；`diagnostics`；`engineering-execution`；`verify-work` | 15 | `gpt-5.6-terra` / `max` / `high` / 4 |
| `review-validation` | `common-core`；`diagnostics`；`review-quality`；`aquatic-code-review`；`context-archiver` | 9 | `GPT-5.6-Terra` / `max` / `high` / 4 |
| `a2a-platform-assistant` | `common-core`；`diagnose`；`review-quality`；`context-archiver` | 7 | `gpt-5.6-terra` / `max` / `high` / 4 |
| `dev-one` | 与 `implementation-builder` 相同 | 15 | `gpt-5.6-terra` / `max` / `high` / 30 |
| `dev-two` | 与 `implementation-builder` 相同 | 15 | `gpt-5.6-terra` / `max` / `high` / 30 |
| `dev-three` | 与 `implementation-builder` 相同 | 15 | `gpt-5.6-terra` / `max` / `high` / 30 |

三个 `dev-*` Bot 的 selector 顺序也完全一致。后续修改开发池时，应把三者视为一个变更单元。

## 项目 Skill 已纳入受管分配

仓库当前发现的项目 Skill 只有 `bytedance-meego`。它已用本地链接注册到 BotMux registry：

```text
/data00/home/root/workspaces/botmux-upstream/.trae/skills/bytedance-meego
```

主 Bot 已显式引用 `skill:bytedance-meego`，其他 8 个 Bot 没有引用。确认显式策略能正常解析后，`/root/.botmux/config.json` 中的 `skills.trustProjectSkills` 已从 `all` 改为 `off`。这样不会因为 Bot 切换工作目录而自动获得项目 Skill，也消除了该 Skill 同时来自 registry 和项目目录时的重复来源告警。

今后新增 Skill 先安装或注册，再按职责加入 Pack 或单独分配。无法明确归类时保持未分配。`botmux-*` 不分配给 TraeX Bot，除非用户明确指定范围。

## Trae Home 现状

本轮没有切换 Trae Home。当前可供后续判断的入口如下：

| 入口 | 实际位置和现状 | 当前作用 |
| --- | --- | --- |
| `/root/.trae` | 实体目录；`traecli.toml` 默认 `GPT-5.6-Sol` / `high`；技能目录当前 17 项 | standalone TraeX 与 9 个 Bot 实际共用。运行中 daemon 的 `TRAE_HOME=/root/.trae` |
| `/root/.trae-botmux-center` | 符号链接到 `/data00/home/root/.trae-botmux-center`；配置默认 `gpt-5.6-sol__max` / `max` / `high`；技能目录当前 29 项 | 预备的 BotMux 专用 Home，当前没有被 9 个 Bot 命中 |
| `/root/.agents/skills` | AgentBuddy 系统级技能库，当前 65 个一级 Skill 目录 | 全局 Skill 来源，不是 `TRAE_HOME` |
| 仓库 `.trae/skills` | 项目级发现入口，当前含 `bytedance-meego` | 自动发现已关闭；该 Skill 通过 registry 本地链接受管使用 |
| 仓库 `.agents/skills` | 同一项目的另一 Skill 发现入口 | 自动发现已关闭，不再隐式分配给 Bot |

如果后续决定隔离 standalone 与 BotMux，应先明确哪一套配置和技能目录是权威来源，再改 daemon 的 `TRAE_HOME`。当前 wrapper 的默认值不会覆盖 daemon 已注入的 `/root/.trae`。

## 验证结果

本轮通过 BotMux 受管命令和 daemon 签名 IPC 更新配置，没有直接覆盖运行中 daemon 的内存状态，也没有关闭现有会话。没有修改仓库源码，因此没有执行 `bun run build` 或重启 fleet。

已完成以下检查：

- `botmux skills doctor`：37 个 registry Skill 全部正常。
- 7 个 Pack 均可展开，revision 都是 1，没有悬挂引用。
- 9 个 Bot 的 `skills resolve` 分别得到 26、7、12、15、9、7、15、15、15 项，全部没有 diagnostics。
- 三个 `dev-*` 的 selector、模型、`modelBackendVariant`、`reasoningEffort` 和 `maxLiveWorkers` 完全一致。
- 9 个 Bot 的 priority policy 中都没有 `botmux-*`。
- `bytedance-meego` 只出现在主 Bot，关闭项目自动发现后仍可正常解析。
- `bots.json`、`registry.json`、`packs.json` 和 `config.json` 都能通过 JSON 校验，权限均为 `0600 root:root`。
- Supervisor、9 个 daemon 和 Dashboard 全部在线，进程没有因本轮热更新重启。

当前验证覆盖配置、解析和服务健康。它没有把既有会话中的 prompt 缓存算作新策略已生效；需要验证真实触发行为时，应在对应 Bot 的新会话中测试。

## 回滚

变更前快照位于：

```text
/root/.botmux/governance-snapshots/20260923T145000+0800/
```

快照包含 `bots.json`、`registry.json`、`config.json`、两个 Trae 配置和 `a2a-trae-botmux` wrapper。变更前没有 `packs.json`，目录内用 `PACKS_JSON_WAS_ABSENT` 记录这一状态。原始 `bots.json` 的 SHA256 是：

```text
f044c1ce59f0178578fff9b1e23382ddbdc11d1bddc790550ba57c56def2231b
```

回滚时应恢复快照中的受管配置，并把 `packs.json` 恢复为不存在的状态，然后按仓库规范执行 `bun run daemon:restart`。本轮没有修改 Trae Home、wrapper 或全局 Skill 内容。

## 保留边界

- 三个职责只读角色尚无系统级只读保证；本轮按用户决定不处理。
- Skill Pack 控制 BotMux 的 priority policy，不会卸载 TraeX 全局技能。
- Trae Home 仍共用 `/root/.trae`；专用 Home 是否启用留待后续决定。
- 本轮没有复制 `chatGrants`，也没有改 owner 身份。`ou_` 继续按 app-scoped 边界处理。
- 本轮没有修改 BotMux 源码、工作目录、会话路由或其他 Bot 的并发上限。
