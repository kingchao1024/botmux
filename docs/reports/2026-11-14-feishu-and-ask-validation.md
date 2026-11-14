# 飞书投递与 Ask 实测

代码已提交为 `33656043f72d689f2a6db081f5a216e9f94dcba3`，并推送到 `origin/master` 和 `upstream/master`；两个远程回读一致。7 个 LLMbox bot 的真实模型回复和飞书投递全部通过。两张 Ask 卡片已在实际私聊发送并回读，截至 20:36（UTC+8）仍在等待真人提交；真实点击回调尚未计为通过。

本轮没有重新构建或重启服务，运行版本仍为 3.59.9，使用此前已部署的修复产物。

## 收件人核验

通过每个 bot 自己的飞书应用，实时解析 `wangchao.2048@bytedance.com`，并查询用户信息。七个应用均返回“宋超”，与原有授权名单对应；不同应用使用各自的 open ID，没有跨应用复用。测试消息只发到这名用户与各 bot 的私聊。

## 真实回复与投递

20:27—20:29（UTC+8），使用各 bot 的真实 daemon 新建独立 headless 会话，沿用当前模型、思考强度、角色及技能配置。每次要求返回随机中文标记，然后通过该 daemon 的 `headless publish` 发到已核验的私聊。以下各项均满足：

- 模型回执为 `completed`，正文完整匹配随机标记。
- 飞书返回 `message_id`，随后用同一应用回读该消息，聊天 ID 和正文均匹配。
- 测试会话已关闭。

| bot | 入口 / 模型 | 模型回执耗时 | 投递结果 / message_id |
| --- | --- | --- | --- |
| readonly-diagnosis | claude-w / deepseek-v4.1-flash | 47.1 秒 | 通过，`om_x100b60b17109d8a0e763c09012b4eee` |
| docs-report | claude-w / glm-5.3-flash | 42.2 秒 | 通过，`om_x100b60b171b8b4a50cfe527601f2485` |
| implementation-builder | codex-w / minimax-m3 | 9.0 秒 | 通过，`om_x100b60b173a0b8a8e761bdc858bb3fa` |
| review-validation | claude-w / kimi-k2.5 | 46.3 秒 | 通过，`om_x100b60b17172b4a10cf6148c32a9d68` |
| dev-one | codex-w / deepseek-v4-flash-0731 | 10.0 秒 | 通过，`om_x100b60b10e0d30a0e7678d0c8eba059` |
| dev-two | claude-w / glm-5 | 53.2 秒 | 通过，`om_x100b60b10db1f0a0e7596593bc1ad5b` |
| review-validation-2 | codex-w / kimi-k2.5 | 9.0 秒 | 通过，`om_x100b60b10e0c08a0e76f51b7e3761d6` |

耗时只统计 trigger 接受后的模型启动、输入和结果采集，不包含随后飞书发布及回读。API 回读证明飞书保存了正确消息；客户端是否显示、真人是否已读，需要另行核验。

## Ask 验收

使用 `review-validation` 和 `implementation-builder` 两个应用，覆盖 Claude、Codex 配置下的 `botmux ask buttons --json --answerer ...`。卡片只确认测试可见，不授权业务操作。只接受已核验用户的真实点击，不通过 Desktop 答案接口代答，也不伪造事件或签名。

20:33，两张卡片发送成功，随后回读得到完整问题、选项、指定答复人和“提交”按钮：

| bot | message_id | 当前状态 |
| --- | --- | --- |
| review-validation | `om_x100b60b11e40bcacb3c1c7eedcf7b58` | 等待真人提交 |
| implementation-builder | `om_x100b60b11e5d0ca0b09ba8632bdeca5` | 等待真人提交 |

用户需分别选择“已收到并确认测试”，再点“提交”；卡片将在 20:43 左右超时。后台的真实 CLI 等待者会记录实际返回值与退出码，并关闭测试会话。当前仍未收到最终结果，不能据卡片发送成功宣称回调通过。

当前服务的可选签名回执未启用。两个 daemon 于 20:13 启动时均记录 `signed receipt authority disabled during startup: marker_missing`，宿主没有签名密钥文件。因此本轮普通 Ask 的成功条件是经过现有用户校验的真实回调及结果回传，不包含签名回执；没有修改该功能的启用门禁。

准备阶段发现两项会话条件：尚未启动 CLI 的 headless 会话绑定私聊返回 `not_started_yet`；模型结果已完成但终端仍忙时，绑定返回 `worker_busy`。另一个准备命令误用了只供 S1 controller 使用的 `--request-id`，CLI 返回退出码 2，未发卡。随后改用真实私聊会话和普通 Ask 参数；这些准备失败没有记为 Ask 成功，也没有修改生产代码或门禁。

## 错误边界与验收范围

已实际执行：非法发布聊天 ID 返回 HTTP 400；Ask 缺字段、字符串超时、外部指定 ask ID、外部指定 host origin 均返回 HTTP 400 和明确 JSON 错误；不带宿主认证的 pending 读取返回 HTTP 401。headless 会话发 Ask 返回 `unsupported`，未发送卡片。

对 Codex 应用的原 Ask，使用相同调用身份增加一个宿主等待连接，并在 1 秒后中断该额外连接。随后原 `askId` 仍在 pending 列表中，未因等待者断连而取消。又以同一身份重新等待，最终去重与结果一致性仍待用户提交后核验。

本轮验收授权只用于测试与记录，没有因准备阶段失败追加生产修复。未执行服务中断、真人事件重放、群聊迁移或故意制造模型鉴权失败；本报告不是完整上线门禁结论。原生 Claude 权限 hook、Codex 工具执行及模型质量不在本轮通过项内。

## 完整性与证据

20:36 的复核确认：测试前的 2432 条会话，其 ID、状态及完整记录摘要均未变；10 个 bot、原进程及 Dashboard 均正常，Dashboard 为 `healthy`。本轮共新增 11 条测试会话，其中 7 条投递会话与 2 条准备会话已关闭，2 条真实 Ask 会话保留等待提交，总记录数为 2443。

Bot 配置、全局配置、原凭据及 root LLMbox 缓存摘要均未变。Codex 在测试时自动更新 MCP 配置；已校验差异范围，备份保留，待两个 Ask 会话结束后恢复并执行最终完整性复核。

私有证据目录：`/root/.botmux/llmbox-repair-20261114/feishu-ask`。其中保存调用结果、消息回读、身份核验、错误边界与完整性摘要，不包含登录令牌或应用密钥。
