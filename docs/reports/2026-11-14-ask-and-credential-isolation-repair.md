# Ask 与凭据隔离修复复测

Ask 新表单校验、reader-lock 目录分类和补测发现的 outbox 挂载顺序错误均已修复并部署。952 个针对性用例和完整构建通过；7 个 LLMbox bot 的真实模型回复、飞书投递与内容回读全部通过，普通 Claude/Codex 私聊启动也已通过。两张新 Ask 卡片已发送，21:23 仍在等待真人选择并提交，成功回调尚未完成验收。本报告随修复代码提交，并按用户授权推送到 `origin/master` 与 `upstream/master`。

## 修复内容

Ask 生成器发出 `custom_form: v1`、`revision` 和 `form_value`，旧入口只认识普通按钮值，因此在业务处理器之前拒绝真人事件。现在由 `src/core/ask-receipt.ts` 提供同一份封闭格式校验，供飞书入口和可选签名 authority 使用。只接受明确的 v1 字段组合；revision 必须是非负安全整数的十进制字符串，普通选项和自定义选项互斥，自定义输入必须为长度不超过 1000 的字符串。nonce、指定答复人、卡片绑定、revision 的业务检查保持原有规则。

新表单原有契约为 `receiptEligible=false`，自定义草稿不兑换签名 provenance。修复保留这一契约：有效 v1 表单不申领签名事件，仍由正常表单处理器验证并结算；格式错误仍拒绝。没有启用签名功能，也没有生成或模拟真人签名回执。旧按钮的签名回执路径继续保留。

凭据隔离增加准确的条目分类：只有 `.device-credential-isolation.lock.readers` 被接受为目录，并用只读空目录整体遮蔽；其他保留凭据和 Dashboard 凭据仍要求普通文件。扫描使用 `lstat`，不跟随符号链接，错误类型在启动前拒绝。没有删除宿主锁目录，也没有关闭隔离。

补测发现，隔离层将共享 `sandboxes` 父目录替换成只读空目录后，才尝试绑定 `<session>/outbox`，导致 bwrap 无法创建挂载点。修复只在父目录封为只读之前创建本会话 outbox 的空路径，随后绑定宿主的该 outbox。其他会话仍不可见，父目录仍不可写。

## 本地证据

- Ask 修复前，实际生成的表单经飞书 SDK 进入真实 dispatcher，有、无 signer 两种设置均被拒绝。修复后，生成表单的普通选项、自定义输入、切换和提交路径通过，并确认没有生成签名回执。
- reader-lock 修复前，真实 PTY、tmux worker 在目录分类处失败。修复后越过该错误；新增文件系统测试覆盖目录遮蔽、宿主 lease 保留，以及错误文件、符号链接、FIFO 和未知保留目录的拒绝。
- outbox 独立真实 bwrap 测试修复前返回 `Can't mkdir parents ... Read-only file system`，与真实 worker 终端错误一致。该测试还校验修复后能写入本会话 outbox、看不到其他会话，并且不能写共享父目录。
- 初次针对性回归 886 个通过；隔离 candidate 完整构建通过。扩展检查中 6 个签名持久化用例受当前工具沙箱的 `/proc/self/fd/...` 写权限限制，未记为通过，未修改目录权限或测试契约。

21:15 最终针对性复跑：6 个测试文件、952 个用例全部通过。其中包含真实 PTY 和 tmux 的 Codex App runner 鉴权及一轮输出，以及真实 bwrap 的 outbox 写入和其他会话隔离检查。未降低或跳过原有 runner 成功断言。

## 部署和真实复测

21:11（UTC+8）首次部署后，10 个 bot 和 Dashboard 正常，新 build id 为 `3a206beb5914ab36698a4ea82e4ed04a2bce7c0b5be78b604e70fc891a3b665d`。2443 条原有会话的 ID、状态、完整记录摘要均保持一致，配置与凭据摘要未变。

这一产物解决了前两处拒绝，但仍受到 outbox 挂载错误影响。21:12 真实复测的 7 个 bot 均返回 `failed / cli_exit_1`，没有成功发布模型回复，不能计为通过。失败回执约 14—16 秒到达，没有等满 90 秒。该轮新增的 7 个测试会话全部关闭；21:14 复核 2443 条历史记录未变，总记录数 2450。Codex 自动配置差异已在校验范围后恢复，全部配置与凭据摘要重新匹配。

21:17 第二轮完整构建通过，包含 TypeScript 编译、typecheck、Dashboard bundle 及 dist/内嵌资源审计。新 build id 为 `a8bbbfe378cf3d7802db06d415933361371d822d06252d5bdaa5c9d29c36a3b6`。服务从 systemd 停止、原子替换产物并启动后，10 个 daemon 的 PID/进程出生标识/build generation 均与新产物一致，Dashboard 为 `healthy`；2450 条记录及配置、凭据摘要全部保持一致。原产物和首次修复产物均保留独立回滚副本。

21:18—21:20 第二轮真实模型及飞书投递：7/7 通过。各 bot 使用当前配置的后端与模型；回执均为 `completed`，正文完整匹配随机中文标记，发布后由同一应用回读消息并核对聊天 ID、正文和未删除状态。7 个 headless 测试会话已关闭。

| bot | 入口 / 模型 | 模型回执耗时 | 飞书回复 message_id |
| --- | --- | --- | --- |
| readonly-diagnosis | claude-w / deepseek-v4.1-flash | 42.2 秒 | `om_x100b60b1b2b5e8a0e76b411cdbfeff7` |
| docs-report | claude-w / glm-5.3-flash | 46.2 秒 | `om_x100b60b1b27520a0e71e95e81e46f7b` |
| implementation-builder | codex-w / minimax-m3 | 8.1 秒 | `om_x100b60b1b49bf4a4e72d851ea70429b` |
| review-validation | claude-w / kimi-k2.5 | 46.3 秒 | `om_x100b60b1b2756d310ceb60c469bed47` |
| dev-one | codex-w / deepseek-v4-flash-0731 | 21.1 秒 | `om_x100b60b1b091f4a0e724f2bdd4fecd6` |
| dev-two | claude-w / glm-5 | 50.2 秒 | `om_x100b60b24ee200a10cff6d3e337fe41` |
| review-validation-2 | codex-w / kimi-k2.5 | 10.1 秒 | `om_x100b60b1b3605ca10ca76da28a58146` |

普通会话创建成功后，验收脚本的一次默认注册目录发现未找到 daemon；实际 systemd 和 fleet-state 显示 10 个原进程仍在线。后续脚本固定使用已核对的数据目录注册路径，继续读取同一会话，没有为该问题修改生产源码。两个会话均返回独立随机 `ASK_READY` 标记，飞书历史回读匹配，终端状态为 `idle`：

| bot | 普通会话 | 模型回复 message_id | 新 Ask message_id |
| --- | --- | --- | --- |
| review-validation | `1f1cf19a-577a-4081-82c6-a1eb098f296e` | `om_x100b60b24c231ca0cd1abd3672cb2d0` | `om_x100b60b246f9bca4b497dc754ef6cf7` |
| implementation-builder | `60699d87-44d7-458f-a08b-000f97c5c288` | `om_x100b60b24f73aca0c1eb41c2531cc9c` | `om_x100b60b246fc40a4cf5689182035154` |

21:22 两张新卡片发送后，回读确认实际表单、两项选项、自定义输入、“提交”按钮和各应用自己核对的答复人。CLI 等待窗口为 20 分钟，截止到北京时间 21:42；后台等待真实回调。请在 [评审验收 Botmux](https://applink.feishu.cn/client/chat/open?openChatId=oc_61bc430ca144add91cb0b873c91f5241) 和 [研发实现 Botmux](https://applink.feishu.cn/client/chat/open?openChatId=oc_2c67a07495b262ff18e2fde5b430cee1) 选择“已收到并确认测试”，再点击“提交”。

21:23 完整性复核：第二轮部署前的 2450 条记录，其 ID、状态、完整记录摘要均未变；总记录数 2459。第二轮新增 7 个 headless 会话已关闭，两个普通会话保留给 Ask 等待者，回调或超时后由等待脚本关闭。Codex 自动配置差异已按范围核对并恢复，所有被核对的配置和凭据摘要均匹配基线。10 个 bot、其原 PID/出生标识和 Dashboard 均正常。

## 尚未通过的范围

真人尚未提交这两张新卡片，因此不能宣称实际成功回调已通过。后台脚本会核对退出码 0、真实答复人和 `answers=[["yes"]]`，随后关闭本轮普通会话；仍需在完成后回读完整性并补充结果。未伪造用户事件、代答或签名，也未把发送成功当作回答成功。

前述 6 个扩展签名持久化用例仍受工具沙箱文件写权限限制；本轮没有修改这些门禁。Claude 原生权限交互、Codex 工具执行和模型质量不在本轮成功项内。

## 证据位置

首次部署：`/root/.botmux/llmbox-repair-20261114/ask-repair-deployment`。

第二轮部署：`/root/.botmux/llmbox-repair-20261114/ask-repair-relay-deployment`。

真实复测：`/root/.botmux/llmbox-repair-20261114/ask-repair-live`；首次失败调用保留在其 `delivery-round-1` 子目录。证据包含测试请求、消息回读、身份和完整性摘要；登录令牌、应用密钥不入库。

旧 dist 备份保留于 `/data00/home/root/workspaces/botmux-llmbox-repair-rollback-20261114` 下本轮独立子目录。服务仅通过 root 的用户级 systemd 管理，并核对 supervisor 的 cgroup 归属。
