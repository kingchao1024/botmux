# 本机 bot 后端与模型分配记录

后续状态（20:16）：LLMbox 租户为 `agent_box`，root 独立登录、退出回执及 Codex 输入识别已打通，7 个 LLMbox bot 实际调用全部通过。当前分配和验收见[登录与回执修复记录](2026-11-14-llmbox-login-and-receipt-repair.md)。以下保留 18:17 的模型分配及当时配置验收证据。

后续实时查询已确认 `agent_box` 有 9 个模型；此前查询误用了令牌缓存中的时间戳，目录查询 401 已纠正。新增模型和包装器接入限制见[LLMbox 模型与入口核对](computer:///data00/home/root/workspaces/botmux-upstream/docs/reports/2026-11-14-llmbox-agent-box-models.md)。

2026 年 11 月 14 日 18:17（UTC+8），已按“Claude 和 Codex 只能用 LLMbox 的模型”修正 7 个 bot。root fleet 仍为 3 个 TraeX、4 个 Claude Code、3 个 Codex。配置文件与运行中的 daemon 回读一致，新建会话使用以下分配。

Claude、Codex 的模型选择依据是本机当天的 LLMbox 缓存。缓存只列出 `deepseek-v4.1-flash`、`glm-5.3-flash`，两者都支持这两个后端，思考强度为 low、high、max。在线 `/models` 查询返回 401，因此没有将缓存结果表述为已完成在线验证。

本轮未配置鉴权，未复制 wangchao.2048 的 LLMbox 或 AgentBox 凭据，也未测试真实推理调用。模型按职责分配，效果尚未评测。

| bot | 应用 ID | 后端 | 模型 | 思考强度 | TraeX 上下文档位 |
| --- | --- | --- | --- | --- | --- |
| main | cli_aac926f0eb795bc1 | TraeX | GPT-6.1-Sol | high | max |
| readonly-diagnosis | cli_aafeeaaf75b85bb4 | Claude Code | deepseek-v4.1-flash | high | — |
| docs-report | cli_aafeeaf0f8fa5bdb | Claude Code | glm-5.3-flash | low | — |
| implementation-builder | cli_aa1e53f7aaf81bc6 | Codex | deepseek-v4.1-flash | high | — |
| review-validation | cli_aa1e4c5508f8dbd3 | Claude Code | glm-5.3-flash | high | — |
| a2a-platform-assistant | cli_aa1e483c85b8dbfc | TraeX | GPT-5.6-Terra | high | standard |
| dev-one | cli_aa1f3189edf99bb4 | Codex | deepseek-v4.1-flash | high | — |
| dev-two | cli_aa24868c4c78dbc1 | Claude Code | deepseek-v4.1-flash | high | — |
| dev-three | cli_aa2486c5c2f89d11 | TraeX | GPT-5.6-Luna | high | standard |
| review-validation-2 | cli_aa3fa2316c21dbd9 | Codex | glm-5.3-flash | high | — |

文档 bot 使用 GLM 的 low 档，其余六个 Claude／Codex bot 使用 high。三个 TraeX bot 的模型、上下文档位和原生子代理策略保持不变。

四个 Claude bot 通过现有环境变量接口设置 `ANTHROPIC_BASE_URL=https://llmbox.bytedance.net`，主模型、原生子代理模型及 Haiku／Sonnet／Opus 默认映射都指向各自选定的 LLMbox 模型。原有环境变量保留，新增项不含鉴权字段。

root 原先没有 Codex 供应商配置，本轮新增 `/root/.codex/config.toml`，默认供应商为 `llmgw`，地址为 `https://llmbox.bytedance.net`，协议为 `responses`。模型目录来自本机 LLMbox 的非凭据模型元数据，保存为 `/root/.codex/llmbox-models.json`。两个新增文件均为 0600，配置不含 token、API key 或登录设置；root 用户新启动的 Codex 默认使用这个入口。

使用现有 `PUT /api/bot-agent` 完成 7 次模型更新，使用 `PUT /api/bot-env` 完成 4 次 Claude 路由更新，再独立回读。最终保存均成功，关闭失配会话、残留会话和关闭失败数量均为 0。首次执行因 Codex 可用性检查未通过而中止，完整恢复配置后重试成功；过程记录保存在 `attempt-1.json`。

| 验收项 | 实际结果 |
| --- | --- |
| 配置文件与运行配置 | 本轮调整的 7／7 一致，三个 TraeX bot 完整配置保持不变 |
| Claude 路由与子代理模型 | 4／4 环境变量回读一致 |
| CLI 启动参数 | 7／7 正确传递模型与思考强度 |
| Codex 原生模型目录 | `codex debug models` 成功，只列出 deepseek-v4.1-flash、glm-5.3-flash |
| Claude Code | `/usr/bin/claude`，2.1.323 |
| Codex | `/root/.local/bin/codex`，0.147.0 |
| TraeX | `/root/.local/bin/traex`，0.209.1 |
| 模型目录来源 | 本机 LLMbox 缓存；在线目录查询返回 401 |
| 历史会话 | 2397 条；会话 ID、closed 状态及完整记录摘要全部保持一致 |
| 角色、技能和原有凭据 | 摘要保持一致，bot 的其他字段保持一致；用户 LLMbox／Claude／Codex 配置与凭据未变 |
| 运行进程 | supervisor PID 3501445、10 个 daemon 和 Dashboard PID 均未变 |
| 在线状态 | 10 个 bot 与 Dashboard 全部 online；Dashboard 健康接口返回 healthy |
| 托管服务 | root 用户级 `botmux.service` 为 active／exited |
| 真实调用 | 未发送推理请求、飞书消息或 Ask 回调；7 个 Claude Code／Codex bot 的调用仍未验证 |

本轮备份和验收证据保存在 `/data00/home/root/workspaces/botmux-llmbox-model-allocation-20261114`，目录权限为 0700，文件为 0600。`before.json`、`bots.json.before` 保存调整前配置，`plan.json` 保存本轮目标，`catalog-summary.json` 保存 LLMbox 模型依据，`journal.json` 保存接口结果，`native-codex-catalog.json` 和 `verify.json` 保存验收结果，`correction-script.mjs` 保留执行脚本。上一版分配记录已保存为 `report-before-correction.md`。

需要恢复时，以 `before.json` 的原配置为依据，通过相应 bot 的模型与环境变量接口恢复，再回读验收。两个新增 root Codex 文件需单独恢复至原先不存在的状态，操作前检查是否有后续改动。直接覆盖 bot 配置文件不会同步运行中的 daemon。

本次没有重启 fleet、重建运行产物、提交或推送。执行时使用既有 3.59.9 运行产物，仓库 HEAD 为 `1681f291470b152fb17b132f0755bd666ce3f8b8`。原有未跟踪文件和 stash 保留。
