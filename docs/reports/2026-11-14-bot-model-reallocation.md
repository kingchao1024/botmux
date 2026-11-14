# Bot 后端、模型重新分配与调用验收

后续状态（20:16）：root 的独立 LLMbox 登录已打通，CLI 退出回执及 Codex 输入识别已修复，7 个 LLMbox bot 的实际调用全部通过。详见[登录与回执修复记录](2026-11-14-llmbox-login-and-receipt-repair.md)。以下保留 18:55—18:58 的分配及当时验收结果。

2026 年 11 月 14 日 18:55—18:58（UTC+8），本机 10 个 bot 已按下表重新分配并回读生效。3 个 TraeX bot 实际调用通过；7 个 LLMbox bot 仍缺 root 登录，不能完成模型调用。10 个 bot 与 Dashboard 均在线。

保留 3 个已验证可用的 TraeX bot，其余 7 个统一经 root 自己的 `claude-w`／`codex-w` 接入 LLMbox，租户为 `agent_box`。

## 当前分配

| bot | 后端入口 | 模型 | 思考强度 |
| --- | --- | --- | --- |
| main | TraeX | GPT-6.1-Sol | high，后端档位 max |
| readonly-diagnosis | Claude Code／claude-w | deepseek-v4.1-flash | high |
| docs-report | Claude Code／claude-w | glm-5.3-flash | low |
| implementation-builder | Codex／codex-w | minimax-m3 | 默认 |
| review-validation | Claude Code／claude-w | kimi-k2.5 | high |
| a2a-platform-assistant | TraeX | GPT-5.6-Terra | high，后端档位 standard |
| dev-one | Codex／codex-w | deepseek-v4-flash-0731 | high |
| dev-two | Claude Code／claude-w | glm-5 | 默认 |
| dev-three | TraeX | GPT-5.6-Luna | high，后端档位 standard |
| review-validation-2 | Codex／codex-w | kimi-k2.5 | high |

实现与审查分别分散到 MiniMax、DeepSeek、Kimi，文档使用 GLM，便于后续用实际任务比较。模型目录只能证明模型可选，本次没有质量评测，因此这份分配不代表对模型能力的排名。`minimax-m3` 与 `glm-5` 的目录未声明思考强度，已移除 bot 的显式强度覆盖。

## 接入调整

- 在 `/root/.local/bin/` 安装 `claude-w`、`codex-w`，均为 root 所有、0700；共享库位于 `/root/.llmbox/lib/_common.sh`，权限为 0600。包装命令源码来自本机已有安装。
- root 的共享库增加“只用已有登录”限制：缺少或过期的 root 登录返回退出码 78，不发起 SSO，也不读取用户目录的令牌供 bot 使用。
- 7 个 bot 显式设置 `LLMGW_SOURCE=agent_box`，补齐包含 `/root/.local/bin` 的 PATH。
- 4 个 Claude bot 设置 `disableCliBypass=true`，停止传入被 root／sudo 拒绝的权限绕过参数；子 agent 及模型别名同步到各 bot 选定的 LLMbox 模型。
- 3 个 Codex bot 设置 `codexRpcInput=false`。当前 RPC 引擎直接启动原生 CLI，绕过通用 `wrapperCli`；终端启动路径才会经过 `codex-w`。
- root 的 Codex 静态模型目录更新为 `agent_box` 的全部 9 个模型。供应商配置添加 `env_key="LLMGW_OPENAI_API_KEY"`，由包装器在启动时提供；本次没有写入密钥。

查询模型目录时，瞬时使用了用户已有的 LLMbox 登录，接口返回 HTTP 200。没有复制、保存或向 root 服务注入该令牌，没有新登录，没有配置 AgentBox／LLMbox 鉴权。

## 实际调用与剩余问题

通过各 bot 的在线 daemon 创建独立 headless 会话，只要求模型返回随机标记，不绑定飞书聊天，不调用工具。

| bot | 本轮检查 | 结果 |
| --- | --- | --- |
| main | 真实模型回合 | 通过，约 8.6 秒 |
| a2a-platform-assistant | 真实模型回合 | 通过，约 8.7 秒 |
| dev-three | 真实模型回合 | 通过，约 8.5 秒 |
| readonly-diagnosis | 包装入口检查及 headless 调用 | CLI 退出码 78，缺 root 登录；回执保持 running，90 秒超时 |
| implementation-builder | 包装入口检查及 headless 调用 | CLI 退出码 78，缺 root 登录；回执保持 running，90 秒超时 |
| docs-report、review-validation、dev-one、dev-two、review-validation-2 | 分别检查当前包装入口与模型参数 | 均返回退出码 78，缺 root 登录；未重复发起已知无法通过的推理请求 |

**7 个 LLMbox bot 仍不能完成模型调用。** 服务使用 `/root` 的配置和登录，用户目录已有登录不会自动生效。当前不存在 `/root/.llmbox/cache/accesstoken`，7 个入口均明确拒绝启动且没有触发 SSO。之前 Codex 的 401 没有因模型重分配而被证明解决；本轮在鉴权缺失时提前返回，尚未向推理接口发起请求。

后续打通调用，需要为服务选择可用的 LLMbox 身份和运行方式。应在 root 服务独立登录与改用已有登录的非 root 服务之间明确选择，不能只换模型或租户。本次按此前“不配置鉴权”的要求保留这一待处理项。

**失败回执问题仍可复现。** 代表性的 Claude、Codex 日志明确记录 CLI 退出码 78，`trigger-result` 却一直保持 `running`，达到 90 秒等待上限。精确中断返回 HTTP 409、`stale_turn`，随后显式关闭会话成功。两条测试记录的 `lastError` 均为空，调用方未及时得到失败结果，需要单独修复这一回执链路。

上一轮记录过 Codex 的 `execution_scope_unproven`，本轮两条代表性启动记录未再匹配到该错误；登录打通后仍应复核，不能据此认定后续工具执行已通过。本次没有修改这些代码，也没有降低相关校验。真实飞书消息、Ask 回调、工具执行、模型质量和长期运行稳定性未验证。

## 备份与验收证据

配置备份与证据保存在 `/root/.botmux/model-reallocation-20261114`，目录 0700、文件 0600：

- `bots-before.json`、`codex-config-before.toml`、`codex-models-before.json`：修改前备份，含敏感配置，仅保留在 root 私有目录。
- `before.json`：2407 条修改前会话的 ID、状态和完整记录摘要，以及配置、凭据摘要。
- `applied.json`、`catalog-summary.json`：实际分配与 9 个模型的目录信息。
- `live.json`：10 个在线 daemon 的后端、模型、强度、包装入口和 RPC 设置回读，全部与磁盘一致。
- `preflight.json`：7 个包装入口逐项检查的退出码与缺登录错误。
- `calls/*/result.json`：本轮实际 headless 调用结果。
- `failure-evidence.json`：两个失败回合的 CLI 退出码、超时回执、精确中断结果和会话 ID。
- `runtime-config-restoration.json`：移除 Codex 测试自动写入的临时 MCP 配置，保留本轮租户与环境变量引用。
- `verification.json`：最终服务健康、会话完整性、配置及凭据复核。

修改前的 2407 条会话，其 ID、状态及完整记录摘要全部一致；其中包括此前的 2397 条历史会话与 10 条已关闭测试记录。本轮新增 5 条测试记录，全部关闭，总数为 2412。角色、技能和权限配置未变，用户及 root 凭据摘要未变。

本次使用 root 用户级 systemd 重启服务，使完整启动配置生效。最终 supervisor PID 为 3775398，cgroup 归属为 `botmux.service`；10 个 bot 均 online，Dashboard 健康接口返回 `healthy`。没有修改仓库源码、提交、推送或重建运行产物。旧备份继续保留。
