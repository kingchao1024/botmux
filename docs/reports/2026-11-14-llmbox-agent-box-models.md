# LLMbox agent_box 模型与包装命令核对

后续状态（20:16）：root 已安装独立包装器并完成登录，7 个 LLMbox bot 实际调用全部通过。当前接入与验收见[登录与回执修复记录](2026-11-14-llmbox-login-and-receipt-repair.md)。以下保留包装器接入前的核对结果。

2026 年 11 月 14 日，按本机包装器的正确登录读取方式实时查询 LLMbox `/models`。默认租户 `llmgw` 返回 HTTP 200、2 个模型，`agent_box` 返回 HTTP 200、9 个模型，新增 7 个。

目录中的全部 9 个模型都标记可用于 Claude Code、Codex、OpenCode、OpenClaw，协议为 `anthropic-messages`。这是模型目录信息，本轮没有逐个验证推理效果。

| 模型 ID | 相对默认租户 | 目录声明的思考强度 |
| --- | --- | --- |
| deepseek-v4.1-flash | 已有 | low、high、max，默认 high |
| glm-5.3-flash | 已有 | low、high、max，默认 high |
| deepseek-v4-flash-0731 | 新增 | low、high、max，默认 high |
| minimax-m3 | 新增 | 未声明 |
| minimax-m2.7 | 新增 | 未声明 |
| minimax-m2.5 | 新增 | 未声明 |
| glm-5 | 新增 | 未声明 |
| kimi-k2.5 | 新增 | low、high、max，默认 high |
| deepseek-v4-flash | 新增 | low、high、max，默认 high |

新增模型可作为后续分工候选。Kimi 和不同版本的 DeepSeek 可按已声明档位选择思考强度；MiniMax 三个版本及 `glm-5` 应先使用模型默认值。目录没有提供足够证据判断哪个模型实现、审查或写作效果更好。

本机现成的 LLMbox 入口是 `claude-w`、`codex-w`、`opencode-w`，均位于 `/home/wangchao.2048/.local/bin/`。三个包装器读取 `~/.llmbox` 的已有 SSO 登录，为各自的底层 CLI 注入网关鉴权和请求头。Claude、Codex 等原生 CLI 也能通过对应配置访问兼容 API；这三个包装器负责完成本机已有的接入步骤。

租户选择必须传递 `LLMGW_SOURCE=agent_box`，包装器默认值仍为 `llmgw`。之前为 bot 设置的 `x-source: agent_box` 是请求头配置，不会自动设置包装器用于查询和选择模型的 `LLMGW_SOURCE`。

| 入口 | 本轮实际检查 |
| --- | --- |
| claude-w | 在 wangchao.2048 用户环境、agent_box 租户下执行带模型参数的 `--version`，成功返回 Claude Code 2.1.323 |
| codex-w | 将已安装的托管 Codex 加入本次命令的 PATH 后，带模型参数的 `--version` 成功返回 0.162.0 |
| opencode-w | 包装脚本存在；当前 PATH 和已检查的常见安装目录未找到原生 opencode，未执行版本或推理验证 |

已执行的版本检查命令：

```sh
LLMGW_SOURCE=agent_box /home/wangchao.2048/.local/bin/claude-w --model deepseek-v4.1-flash --version

LLMGW_SOURCE=agent_box PATH="/home/wangchao.2048/.gdpa-agent-box/managed-node/tools/CODEX/node_modules/.bin:$PATH" /home/wangchao.2048/.local/bin/codex-w --model deepseek-v4.1-flash --version
```

Codex 还有模型目录问题。本轮执行 `codex-w --model kimi-k2.5 debug models`，原生目录仍只返回 `deepseek-v4.1-flash`、`glm-5.3-flash`。用户 Codex 配置通过 `model_catalog_json` 指向默认租户的静态缓存；包装器对自定义租户实时查询时不会把结果写进默认缓存。因此，网关已有 9 个模型，当前 Codex 原生模型目录仍为 2 个。新增模型的原生目录与调用还需按租户验证。

现有 Botmux root fleet 仍使用原生 Claude／Codex 入口。root 下没有 `/root/.llmbox/lib/_common.sh` 或 `/root/.llmbox/cache/accesstoken`，把命令名改成用户安装的包装器不足以启动；包装器按进程 HOME 查找自己的库和登录。Claude 的 root／sudo 危险权限参数限制也不会被包装器消除。

下一轮接入应确定运行用户和原生 CLI 路径，通过 Botmux 已有 `wrapperCli` 机制选择包装器，并传入 `LLMGW_SOURCE=agent_box`。Codex 需要同步处理租户模型目录，再逐 bot 验证调用。本轮只核对入口与模型，没有修改 bot、服务、用户登录或鉴权配置，没有提交或推送。

此前模型目录查询误报 401 的原因已查清：`~/.llmbox/cache/accesstoken` 第一行是时间戳，第二行才是令牌。之前的查询误用了第一行。本轮按包装器逻辑读取第二行，仅用于查询目录，未显示或保存令牌。此前 root bot 在无鉴权配置下进行的推理请求仍确实返回 401，属于另一组已执行的验证，结论不变。
