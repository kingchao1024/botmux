# 飞书投递与 Ask 实测

本报告保留首次验收的失败证据。该轮代码已提交为 `33656043f72d689f2a6db081f5a216e9f94dcba3`，并推送到 `origin/master` 和 `upstream/master`；两个远程回读一致。7 个 LLMbox bot 的真实模型回复和飞书投递全部通过。Ask 验收失败：用户实际点击两张卡片均报“无法安全确认此次操作”，20:43（UTC+8）两个 CLI 等待者均自然超时并返回 124。

用户随后授权修复并重新实测。修复与新一轮验收见 [Ask 与凭据隔离修复](2026-11-14-ask-and-credential-isolation-repair.md)；以下“未修改”“待授权”等表述仅指首次验收结束时的状态。

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
| review-validation | `om_x100b60b11e40bcacb3c1c7eedcf7b58` | 点击被拒绝，CLI 超时 124 |
| implementation-builder | `om_x100b60b11e5d0ca0b09ba8632bdeca5` | 点击被拒绝，CLI 超时 124 |

用户截图确认卡片和之前的模型回复在客户端可见，但点击时显示错误。daemon-3 于 20:34:09、daemon-4 于 20:34:27 均记录 `[ask-receipt] malformed ask callback rejected before handler`。20:43:14，两个 CLI 返回 `timedOut: true`、`answers: null`、`by: null`、退出码 124，随后测试会话关闭。拒绝发生在问题处理器之前，没有消费用户的选择，不能记为成功回调。

当前服务的可选签名回执未启用。两个 daemon 于 20:13 启动时均记录 `signed receipt authority disabled during startup: marker_missing`，宿主没有签名密钥文件。本轮拒绝发生在签名 issuer 判断之前，因此不能归因于签名功能未启用；没有修改该功能的启用门禁。

准备阶段发现两项会话条件：尚未启动 CLI 的 headless 会话绑定私聊返回 `not_started_yet`；模型结果已完成但终端仍忙时，绑定返回 `worker_busy`。另一个准备命令误用了只供 S1 controller 使用的 `--request-id`，CLI 返回退出码 2，未发卡。随后改用真实私聊会话和普通 Ask 参数；这些准备失败没有记为 Ask 成功，也没有修改生产代码或门禁。

## 已定位的失败原因

**Ask 表单生成与入口校验不一致。** `src/im/lark/ask-custom-form.ts` 的 `buildAskCustomForm` 为按钮生成 `custom_form: v1`、`revision` 等字段，选项按钮使用 `form_submit`。`src/im/lark/event-dispatcher.ts` 的 `validateAskCallbackShape` 仍按旧按钮格式校验，选项值只接受 `action / ask_id / nonce / key / question_index`，提交值只接受 `action / ask_id / nonce`，并且不允许 toggle 携带 `form_value`。

在独立进程中，用已保存的真实问题调用当前部署版 `buildAskCustomForm`，再调用当前部署版 `hasExactAskCallbackValueKeys`：两个普通选项和“提交”的实际生成值均返回 false；单独去掉 `custom_form` 或 `revision` 仍返回 false，去掉两者后的旧格式返回 true。toggle 的表单 envelope 也返回 false。这与两个 daemon 的实际拒绝分支一致，排除了“用户没有提交”“用户权限处理器拒绝”及“签名 issuer 拒绝”作为已观察错误的原因。没有向在线 daemon 发送伪造的真人事件。

**Codex 普通会话启动另有目录分类错误。** 用户截图还显示会话 `f8c98136` 启动失败；daemon-3 于 20:33:13.797 记录：

`[device-credential-isolation] authority entry is not a regular file: /root/.botmux/.device-credential-isolation.lock.readers`

该路径实际是 root 持有的 0700 空目录，不是符号链接。当前部署版 `isCredentialIsolationReservedBasename` 将其归入凭据隔离保留名；`src/worker.ts` 在装配隔离路径时却要求该类条目全部为普通文件，故在启动 CLI 前拒绝。直接读取实际路径的 stat 并调用保留名判定，得到 `reservedName=true / regularFile=false / directory=true / symlink=false`，对应上述错误。没有删除该目录、关闭隔离或放宽文件检查；目录的创建来源尚未追溯，本轮只确认了类型与启动检查的冲突。

这两项属于不同链路：Ask 回调格式错误同时影响 Claude 与 Codex 应用；目录分类错误发生在 Codex 普通私聊会话启动时。之前的 7 次 headless 实际模型调用及显式 publish 通过，不能证明普通私聊启动链路同样通过。

## 错误边界与验收范围

已实际执行：非法发布聊天 ID 返回 HTTP 400；Ask 缺字段、字符串超时、外部指定 ask ID、外部指定 host origin 均返回 HTTP 400 和明确 JSON 错误；不带宿主认证的 pending 读取返回 HTTP 401。headless 会话发 Ask 返回 `unsupported`，未发送卡片。

对 Codex 应用的原 Ask，使用相同调用身份增加一个宿主等待连接，并在 1 秒后中断该额外连接。随后原 `askId` 仍在 pending 列表中，未因等待者断连而取消。又以同一身份重新等待，最终也返回 `kind: timedOut`；这证明等待失败有明确终态，但没有取得成功回答，不能宣称成功回调的去重已通过。

本轮验收授权只用于测试与记录，没有因准备阶段失败追加生产修复。未执行服务中断、真人事件重放、群聊迁移或故意制造模型鉴权失败；本报告不是完整上线门禁结论。原生 Claude 权限 hook、Codex 工具执行及模型质量不在本轮通过项内。

## 完整性与证据

20:44 的最终复核确认：测试前的 2432 条会话，其 ID、状态及完整记录摘要均未变；10 个 bot、原进程及 Dashboard 均正常，Dashboard 为 `healthy`。本轮新增的 11 条测试会话全部关闭，总记录数为 2443。

Bot 配置、全局配置、原凭据及 root LLMbox 缓存摘要均未变。Codex 在测试时自动更新的 MCP 配置已在校验差异范围后恢复，最终配置与凭据摘要全部匹配测试前基线。本轮没有重启服务，没有修复生产代码；需在获得修复授权后处理上述两个问题，再重发真实卡片验收。

私有证据目录：`/root/.botmux/llmbox-repair-20261114/feishu-ask`。其中保存调用结果、消息回读、身份核验、错误边界与完整性摘要，不包含登录令牌或应用密钥。
