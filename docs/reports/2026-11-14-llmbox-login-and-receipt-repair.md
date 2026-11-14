# LLMbox 登录与错误回执修复

截至 2026 年 11 月 14 日 20:16（UTC+8），root 的独立 LLMbox 登录已打通，7 个 LLMbox bot 的实际调用全部通过。CLI 退出回执和 Codex 输入框识别修复已部署，10 个 bot 与 Dashboard 在线，已有会话完整保留。

模型及后端分配保持上一轮结果，Claude／Codex 继续通过 `claude-w`／`codex-w` 使用 `agent_box`。

## 修复范围

普通 HTTP／headless 请求没有 `dispatchAttempt`。原 worker 只在有该字段时报告 CLI 退出终态，daemon 的退出回调则只补齐带幂等键的请求，因此普通请求在 CLI 退出后仍保持 `running`。

退出回执修复位于 `src/worker.ts`：

- 普通无飞书投递的回合在 CLI 退出时，先读取可能已经写出的完成记录，再通过现有 `emitTurnTerminal` 报告失败。
- 错误码包含退出码或信号，例如 `cli_exit_78`；现有 daemon 逻辑同步结束等待请求，并将异步结果持久化为 `failed`。
- 只移除该失败回合的待重放输入，保留后续请求。计划内重启、已完成回合、旧 backend 退出、带 attempt 的受控重试继续沿用既有处理。
- 没有放宽 `stale_turn`、worker 世代、执行身份或凭据校验。

## 测试证据

新增测试使用真实 worker、私有 tmux 与立即返回 78 的假 CLI，复现“CLI 已退出却没有请求终态”。修改前断言失败，修改后通过，失败终态先于 CLI 退出事件到达。

另有 4 个测试通过真实 daemon 消息处理和临时异步结果存储验证：

- headless、异步 HTTP、等待 HTTP 的失败都结束请求并写入失败记录。
- 后续排队请求仍保持 pending。
- 已完成的 headless 输出不被稍后的退出事件覆盖。

相关扩展检查共 437 个通过、10 个失败。10 个失败在未修改的 HEAD 上逐项复现，涉及 LinkRef、内容审计、隐藏任务收尾、V2 收件人和重试冷却；不由本次补丁引入，未夹带修改。

扩展测试曾在 Bun 的 Vitest 运行器下于 `z.object` 导入时报错，未执行到断言。改用本机 Node 22.16.0 后获得上述结果。修复的真实 worker 回归同时在 Bun 1.4.4 下通过。没有将导入失败或 runner 退出码误记为通过。

## 在线回执验收

19:24—19:25，使用线上 daemon 创建独立 headless 会话，沿用各 bot 的真实配置。当时 root 尚无 LLMbox 登录，因此包装入口返回 78。

| bot | 模型 | 请求结果 | 耗时 | 测试会话 |
| --- | --- | --- | --- | --- |
| readonly-diagnosis | deepseek-v4.1-flash | failed，`cli_exit_78`，未超时 | 约 15.2 秒 | 已关闭 |
| implementation-builder | minimax-m3 | failed，`cli_exit_78`，未超时 | 约 16.2 秒 | 已关闭 |

修复前同一类请求在 CLI 退出后一直保持 `running`，等待 90 秒后超时。本轮两个请求都及时返回 `worker reported terminal failure: cli_exit_78`，无需精确中断来结束。

这两条检查验收的是失败回执，不能计为模型调用成功。新增 2 条测试记录均已关闭，总记录数为 2414。修改前会话的 ID、状态及完整记录摘要未变；配置及已有凭据摘要未变，进程未因测试重启。Codex 自动写入的测试配置已恢复。

## 构建与运行

候选构建来自 HEAD 的隔离副本，覆盖本次 `worker.ts` 补丁，复用既有依赖，没有安装或更改依赖。编译、typecheck、Dashboard bundle、域名审计、dist 审计和嵌入资源审计均通过。

构建步骤与 `package.json` 一致，显式调用服务专用 Bun 1.4.4，避免共享 `node_modules/.bin/bun` 中的 1.4.3 抢先。TypeScript 使用已有 5.9 fallback。

运行产物切换通过 root 用户级 systemd 进行。工作区与 `/root` 属于不同文件系统，产物暂存与回滚使用工作区同一文件系统上的私有目录：

`/data00/home/root/workspaces/botmux-llmbox-repair-rollback-20261114`

第一次跨文件系统移动被拒绝，旧产物未替换，服务重新启动。随后发现部署检查误用了不包含 `runtimeGeneration` 的简化 daemon 列表；该次检查自动恢复旧产物。最终检查改为读取原始描述符，并与在线进程的 PID、启动身份及应用 ID 匹配。

连续重启还触发了现有 `start-limit-hit`。确认旧产物已恢复后，执行一次 `systemctl --user reset-failed botmux.service` 并启动服务，未修改启动频率保护配置。

退出回执补丁于 19:23:16 部署验收通过：当时 supervisor PID 为 3894406，cgroup 归属 `botmux.service`；10 个 daemon 的原始描述符均匹配候选构建，Dashboard 返回 `healthy`，2412 条会话及配置摘要保持一致。

该阶段的 runtime build id 为 `d2cb1861bd36be9bc20bbb8a270a06733a517fefde0c917e46dd42bd56dc0fac`。运行版本为 3.59.9，当时产物包含未提交的 worker 补丁；当前构建标识见下方输入识别修复记录。

## 登录状态与证据

用户完成 SSO 浏览器授权后，root 登录程序成功保存独立缓存 `/root/.llmbox/cache/accesstoken`。缓存由 root 持有，文件 0600、缓存目录 0700；没有复制用户目录的令牌，也没有在报告、日志或仓库中保存令牌内容。

使用 root 新登录访问 `agent_box` 的模型目录返回 HTTP 200，共 9 个模型。调用前后缓存摘要保持一致。

## 授权后的首轮 7 个 bot 实测

19:29—19:34，通过各 bot 的真实 daemon、当前默认模型和思考强度创建独立 headless 回合，要求返回随机短标记。没有发送飞书消息或调用工具，等待窗口为 90 秒。

| bot | 入口 | 模型 | 实际结果 |
| --- | --- | --- | --- |
| readonly-diagnosis | claude-w | deepseek-v4.1-flash | 通过，约 84 秒返回标记 |
| docs-report | claude-w | glm-5.3-flash | 超时，未得到最终结果 |
| implementation-builder | codex-w | minimax-m3 | 超时，未得到最终结果 |
| review-validation | claude-w | kimi-k2.5 | 通过，约 48 秒返回标记 |
| dev-one | codex-w | deepseek-v4-flash-0731 | 超时，未得到最终结果 |
| dev-two | claude-w | glm-5 | 通过，约 55 秒返回标记 |
| review-validation-2 | codex-w | kimi-k2.5 | 超时，未得到最终结果 |

4 个超时请求的 `trigger-result` 在等待结束时仍为 `running`，未返回明确终态；3 个 Codex 测试记录没有获取到 native `cliSessionId`。启动日志确认模型参数已正确传入对应 `codex-w`。没有足够证据把这些超时归因于模型、鉴权、MCP、输入投递或结果采集中的某一个环节。

补充运行原生命令，使用相同 root 登录和模型：

- `codex-w exec --model minimax-m3`：13.6 秒内成功返回标记，退出码 0。
- `claude-w --model glm-5.3-flash --print`：4.9 秒内成功返回标记，退出码 0。

原生命令验证了这两个入口及模型在该调用方式下可用，不能替代 bot 的会话链路验收。原生 Codex 测试使用 read-only、跳过 Git 目录检查并清空 MCP 启动配置；Claude 使用 print 模式，因此与 Botmux 的交互模式、上下文及 MCP 环境存在差异。该阶段的四个超时 bot 没有计为通过；后续定位及完整复测如下。

本轮新增 7 条 Botmux 测试记录全部关闭，总数为 2421。修改前的 2414 条记录，其 ID、状态及完整摘要保持一致；配置、已有凭据和 root 新登录缓存摘要均未变。10 个 bot 与 Dashboard 保持在线，原生命令测试后再次通过完整性复核。

## Codex 输入识别修复

20:00—20:04，保留活跃终端重新检查四个超时 bot。文档 bot 在 48.2 秒内完成并返回正确标记；三个 Codex bot 观察到 240 秒仍未提交提示词。它们的终端已显示完整模型、目录和输入框，日志却持续保持 `Holding first write — Codex input box is not ready yet`。

本机 Codex 0.147.0 会显示随机灰色占位提示，例如 `Summarize recent commits`、`Run /review on my current changes`。Botmux 的输入保护只识别空行或 `Ask Codex to do anything`，因此将已就绪的旧版输入框判为未知状态，保留提示词而不提交。这是三个 Codex bot 的直接阻塞；延长模型等待窗口不能解决它。

修复在原输入判定处增加灰色占位提示的正向证据：

- tmux 同一次截图同时提供纯文本和 SGR 样式；其他消费者仍读取原来的纯文本。
- 只有光标位于空输入框起始位置、相邻页脚已初始化，且提示文字全部带 dim 样式时，才接受其他原生占位提示。
- 普通草稿、缺少样式或页脚、编号菜单、加载状态继续拦截。执行身份、worker 世代和终态归属校验没有变化。

原生补充检查将占位提示原样输入，再把光标移到 Home：同样的文字和光标位置下，原生提示带 dim，实际草稿不带 dim。没有按 Enter、发起推理或执行工具；私有测试终端已关闭。证据位于 `live-check/native-draft-proof.json`。

新增回归修改前得到 `expected 'unknown' to be 'empty'`，修改后通过；真实 worker 与私有 tmux 的新增用例也确认提示词只提交一次。六个相关测试文件共 288 项通过、1 项失败。失败的既有用例 `keeps checking the backend screen after the soft timeout and delivers once the box is ready` 等待超时诊断日志，单独复跑仍失败，并在未修改的 HEAD 隔离副本中得到相同失败。本次没有修改或跳过它。

候选构建的编译、typecheck、Dashboard bundle 和三项审计通过。20:13:57，通过 root 用户级 systemd 部署一次，10 个在线 daemon 的原始描述符均匹配新构建，Dashboard 为 `healthy`，2425 条已有记录及配置、凭据摘要保持一致。运行版本仍为 3.59.9，supervisor PID 为 4061111。

新 runtime build id 为 `5b0fea626cdd73e0fab18e17d39e70f17a7a5fa001b9b21ba8df313ef5801374`；上一轮产物保留在回滚目录的 `composer/dist-before`，没有覆盖此前的回滚证据。

## 最终 7 个 bot 实测

20:14:36—20:16:19，通过各 bot 的真实 daemon 新建 headless 会话，沿用当前后端、模型、思考强度、角色和技能配置。每次只要求返回随机短标记，未绑定飞书聊天。下表耗时包含 CLI 启动、提示词提交、模型回复及 Botmux 结果采集，不是纯推理耗时。

| bot | 入口 | 模型 | 思考强度 | 实际结果 |
| --- | --- | --- | --- | --- |
| readonly-diagnosis | claude-w | deepseek-v4.1-flash | high | 通过，45.4 秒 |
| docs-report | claude-w | glm-5.3-flash | low | 通过，43.6 秒 |
| implementation-builder | codex-w | minimax-m3 | 默认 | 通过，8.2 秒 |
| review-validation | claude-w | kimi-k2.5 | high | 通过，47.0 秒 |
| dev-one | codex-w | deepseek-v4-flash-0731 | high | 通过，13.5 秒 |
| dev-two | claude-w | glm-5 | 默认 | 通过，53.4 秒 |
| review-validation-2 | codex-w | kimi-k2.5 | high | 通过，13.2 秒 |

七个请求均返回完整且匹配的标记，`trigger-result` 为 `completed`，没有超时。三个 Codex 会话均取得原生 `cliSessionId`，此前输入框门禁阻塞已消除。

七条测试记录全部关闭，总数为 2432；复测前的 2425 条记录，其 ID、状态及完整摘要均未变。Codex 自动写入的测试配置已恢复；bot 配置、全局配置、已有凭据和 root 新登录缓存摘要均未变。复测没有重启进程，10 个 bot 在线，Dashboard 为 `healthy`。

本轮验证了七个 bot 的单轮实际调用与结果回传。真实飞书投递、Ask 回调、工具执行、模型质量和长期稳定性仍未验收；此次连通性通过不能替代这些检查。相关扩展测试的既有失败也没有计为通过。

证据目录为 `/root/.botmux/llmbox-repair-20261114`，包含：

- `worker.patch`、修改前配置和会话摘要。
- `test-red.log`、`test-green.log`、`test-receipts.log`。
- `test-expanded.log`、`test-baseline.log`。
- `deployment.json`：首轮退出回执补丁的部署验收。
- `failure-check/`、`model-check/`：实际 bot 调用及完整性验证记录。
- `model-check/auth-validation.json`：root 登录权限及目录访问检查，只有缓存摘要，没有令牌内容。
- `native-codex-result.json`、`native-claude-result.json`：原生命令的结构化返回和耗时，已遮蔽登录令牌。
- `live-check/`：四个超时 bot 的复现、活跃终端截图、原生草稿检查及完整性复核。
- `composer-deployment/`：输入识别修复、回归 red／green、既有失败对照、部署及回滚记录。
- `final-seven/`：七个实际调用的结果、终端截图、测试配置恢复和最终完整性复核。

旧运行产物保留在回滚目录。源码改动和报告尚未提交、推送，没有发布新版本。
