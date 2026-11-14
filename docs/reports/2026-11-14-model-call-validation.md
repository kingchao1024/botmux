# 本机服务与模型调用验证

历史记录：后续已打通 root 独立登录，修复退出回执和 Codex 输入识别；20:16 的完整复测为 7／7 LLMbox bot 通过。当前结果见[登录与回执修复记录](2026-11-14-llmbox-login-and-receipt-repair.md)。以下保留 18:24—18:32 的现场证据。

2026 年 11 月 14 日 18:24—18:32（UTC+8），10 个 bot 的实际调用验证完成，3 个 TraeX bot 通过，4 个 Claude、3 个 Codex 未通过。

后续使用用户已有包装器登录实时查询，`agent_box` 模型目录已返回 200，共 9 个模型。此前目录查询 401 源于误读令牌缓存，已纠正；本报告记录的 root 无鉴权推理请求 401 仍为真实复现。详见[LLMbox 模型与入口核对](computer:///data00/home/root/workspaces/botmux-upstream/docs/reports/2026-11-14-llmbox-agent-box-models.md)。

通过 root 用户级 systemd 启动本机 `botmux.service`。服务此前已在运行，本次 start 没有替换 supervisor 或重启 bot。最终服务为 active／exited，10 个 bot 与 Dashboard 全部 online，Dashboard 健康接口返回 healthy，supervisor PID 仍为 3501445，进程归属为 root 用户级 `botmux.service`。

LLMbox 已切换到 `agent_box`。四个 Claude bot 的 `ANTHROPIC_CUSTOM_HEADERS` 为 `x-source: agent_box`，三个 Codex bot 使用的 root 供应商配置也设置了同一请求头。切换后逐项回读，其他模型、环境变量与凭据保持原状。

本轮通过每个 bot 的实际 daemon 创建独立 headless 会话，使用当前默认后端、模型、思考强度和上下文档位，不覆盖模型选择。每次只要求返回一个随机短标记，等待上限为 90 秒。测试会话未绑定飞书聊天，结束后通过接口关闭。

| bot | 后端 | 配置模型 | 实际结果 | 测试会话 ID |
| --- | --- | --- | --- | --- |
| main | TraeX | GPT-6.1-Sol | 通过，约 14 秒返回标记 | d9b10bc8-aff2-4c69-adf7-8389b722ec92 |
| readonly-diagnosis | Claude Code | deepseek-v4.1-flash | 未通过，90 秒超时 | 58983bec-0772-4748-bd3c-697b8b15b73d |
| docs-report | Claude Code | glm-5.3-flash | 未通过，90 秒超时 | 0f660304-0962-4be4-9874-d71b34c867ba |
| implementation-builder | Codex | deepseek-v4.1-flash | 未通过，90 秒超时 | e942bafc-15fb-4751-b138-71b332eeceb6 |
| review-validation | Claude Code | glm-5.3-flash | 未通过，90 秒超时 | e08e7452-5023-4b78-92b1-53657f2b046e |
| a2a-platform-assistant | TraeX | GPT-5.6-Terra | 通过，约 8 秒返回标记 | d3035ff2-daca-4a00-845b-747f1a8f7f84 |
| dev-one | Codex | deepseek-v4.1-flash | 未通过，90 秒超时 | 0da883a8-06b5-4537-825d-c5ea99a4bb20 |
| dev-two | Claude Code | deepseek-v4.1-flash | 未通过，90 秒超时 | c9600119-f1eb-4227-aebf-a807b96dcee3 |
| dev-three | TraeX | GPT-5.6-Luna | 通过，约 8 秒返回标记 | 8748669b-7130-45c9-93d4-a79248979e36 |
| review-validation-2 | Codex | glm-5.3-flash | 未通过，90 秒超时 | 1decd7a3-2656-4ce4-b472-086123585fdd |

已执行的原生补充复现确认两个阻塞：

- Claude 当前带 `--dangerously-skip-permissions` 启动，原生 CLI 在 root／sudo 下拒绝运行，退出码为 1。实际错误为 `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`。
- Codex 使用 LLMbox 的 `responses` 入口调用模型，返回 HTTP 401，错误为 `authentication failed`。使用当前无鉴权配置直接请求 LLMbox 的 Anthropic、Responses 入口，也都返回 401。

还观察到 headless 失败回执问题：原生 CLI 已退出或模型回合已失败时，服务的 trigger-result 仍可能保持 running，最终达到等待上限。对已退役回合请求精确中断返回 `stale_turn`，随后显式关闭测试会话成功。Codex 测试日志包含 `execution_scope_unproven`，本轮只记录这一运行证据，没有修改相关代码。

原有 2397 条历史会话的 ID、状态和完整记录摘要保持一致。本轮新增 10 条测试记录，全部已关闭，记录与证据保留。除已授权的租户切换外，bot 配置、全局配置和凭据摘要通过复核。

运行过程中，root Codex 配置新增了 Botmux MCP 和父目录的项目可信项。已保存配置差异，并在关闭测试会话后恢复为切换租户后的配置，`agent_box` 保留。恢复后重新通过配置、凭据、历史会话和进程校验。

继续打通 Claude／Codex 调用，需要处理 Claude 的 root 启动参数和 LLMbox 鉴权。失败回执超时需另外定位，避免原生回合失败后调用方一直等待。本轮没有调整这些启动参数、配置鉴权或修改代码。

本轮遵守此前“不配置鉴权”的要求，没有登录、复制或注入 LLMbox／AgentBox 凭据。验证覆盖单轮实际调用、错误响应和测试会话清理；模型质量、长期稳定性与真实飞书消息投递不在本次验证范围内。

证据目录为 `/data00/home/root/workspaces/botmux-model-call-validation-20261114`，目录为 0700，文件为 0600。`results.json` 保存 10 个调用结果，`verification.json` 保存最终完整性校验；`native-claude-probe.json`、`native-codex-probe.json`、`gateway-auth-check.json` 和 `startup-log-evidence.json` 保存失败复现；`tenant-before.json`、`tenant-switch.json` 保存租户变更依据，`runtime-config-restoration.json` 保存运行配置恢复记录。没有提交、推送或重建运行产物。

临时执行脚本已删除。沙箱拒绝删除空目录 `/data00/home/root/workspaces/botmux-model-call-validation-work-20261114`，该空目录保留，未绕过权限限制。
