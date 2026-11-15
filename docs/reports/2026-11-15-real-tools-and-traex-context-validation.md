# 真实工具、权限交互与 TraeX 上下文预算验收

更新时间：2026-11-15 13:15（UTC+8）。

当前结果：全部验收项通过。TraeX 固定上下文超预算问题已修复并完成生产部署；Codex 真实工具调用、Claude 真实 Write、人工权限卡的允许与拒绝两个回调分支均取得真人操作证据；测试会话已关闭，历史会话与凭据守卫零变化。

## TraeX 截图问题

截图报错为：固定上下文 4618 bytes，超过本轮 4096 bytes 上限。系统拒绝发送，没有截断正文或授权边界。

在 main 的原会话 `7854eeed-c328-4c04-998e-fc12d3658c3b` 上，只读取得 `lastCliInput`，在独立诊断线程中复现：

| 检查 | 结果 |
| --- | --- |
| 原始输入总字节数 | 5353 |
| 初次注入的固定上下文 | 5180 |
| 原逻辑的后续轮固定上下文 | 4618，触发 4096 上限 |
| 候选产物的后续轮固定上下文 | 1567，通过 4096 上限 |
| 用户正文及身份信息 | 从第一个可变块开始的完整后缀逐字保留 |
| 白板上下文 | 保留 |
| 旧回执兼容 | 摘要不匹配时完整重新注入，使用原有 24 KiB 初次预算 |

根因：原生线程回执只对 `<role>` 和技能目录去重，系统生成的 `<project_group_mode>` 每轮仍然重复注入，导致后续轮超预算。

最小修复：将可信前缀中的群协作上下文纳入现有 `roleDigest`，仅在同一原生线程已确认接收、且摘要未变时省略。内容变化时重新注入；回执未知时继续阻止发送。保留原有预算和回执格式。用户正文里的同名 XML 不参与去重。

修改文件：

- `src/core/traex-native-context.ts`
- `test/traex-native-context.test.ts`

验证证据：

- 修复前，新回归用例出现 3 个预期失败，其中后续轮固定上下文 6281 bytes 超过 4096 bytes。
- 修复后，上下文和群协作测试共 206 项通过。
- RPC 配置、运行链路及 Claude 权限监听相关测试共 40 项通过。
- 补充旧回执迁移及排队内容重校验后，上下文测试最终 18/18 通过。相关检查合计覆盖 247 个测试。
- 隔离候选的完整 build、typecheck、构建产物及嵌入资源审计通过。
- 候选源码和当前工作区源码逐文件比对一致，`package.json`、锁文件和 TypeScript 配置一致。复用已有依赖，没有安装依赖。
- `git diff --check` 通过。
- 未执行全仓测试；本轮未重跑此前受环境限制的签名测试。

候选目录：`/tmp/botmux-traex-fix-build-20261115`

候选 runtime build ID：`b4d6722250b45337876fe3767bd046017fca8d9e9d51e6d392bbb88f54754c61`

原始输入摘要：`f652fa84f2f8d2e99d263ee8efb8b9379bbdfe620b793202c59176b3e309f6f1`

证据目录：`/root/.botmux/traex-context-repair-20261115`。原会话及用户消息没有修改。

## 生产部署

部署时间：2026-11-15 12:49（UTC+8），通过 root 用户 systemd user unit 完成停服、替换 dist、启动，脚本含断言失败自动回滚。

| 部署后核对 | 结果 |
| --- | --- |
| runtime build ID | `b4d6722250b45337876fe3767bd046017fca8d9e9d51e6d392bbb88f54754c61`（旧 ID `a8bbbfe3…36a3b6`） |
| 在线 daemon | 10 个，Dashboard healthy |
| 主会话 `7854eeed-c328-4c04-998e-fc12d3658c3b` | 恢复为 active |
| 历史 closed 行 | 2461 条摘要零变化 |
| 凭据与配置守卫 | 未变 |
| 现网 dist 真实输入复验 | 通过，steady 固定上下文 1567 bytes |

回滚副本：`/data00/home/root/workspaces/botmux-traex-context-rollback-20261115/dist-before`。部署记录：`/root/.botmux/traex-context-repair-20261115/deployment/`。

## Codex 真实工具验收

Bot：`implementation-builder`；客户端：`codex`，通过 `codex-w` 使用 LLMbox `minimax-m3`。

测试会话：`c788e333-00b8-4d9a-92e7-b5b86b2d7205`。

测试目录：`/root/.botmux/tool-validation-20261115/implementation-builder`。

原生 rollout 与实际文件共同验证：

- 读取 Unicode 文件，内容包含中文、`café` 和 `🐟`，文件共 71 字节，回传内容一致。
- 读取空文件，实际字节数为 0。
- 实际执行 `pwd`、`wc -c` 等命令，结果与宿主文件回读一致。
- 实际创建 `output.txt`。首次写入带末尾换行，为 45 字节；追加明确字节要求后，用 `printf` 修正为 44 字节，内容与随机验收标记完全一致。
- 原生记录包含 `exec_command`、`apply_patch` 调用，保留了工具输入和执行结果。
- 最终结果已发布到该 bot 的已核验飞书私聊，并回读确认目标聊天一致。
- 测试会话已关闭。

飞书结果 message ID：`om_x100b60a76e83c530e71c23703f8fcf9`。

观察到的边界：第一次准备轮的模型输出已完成，但 API 一度继续显示 working。后续实际工具轮正常收敛为 completed/idle。本轮没有把这个状态观察判定为已修复的问题。

## Claude 真实工具与权限验收

Bot：`dev-two`；客户端：`claude-code`，通过 `claude-w` 使用 LLMbox `glm-5`，`disableCliBypass` 保持开启。

部署前的旧测试会话 `e90df1b7-4009-404b-891f-d8fc9a236feb` 已关闭；部署后重建会话 `ebcf5a66-e8d3-4667-bccd-ac8a75a5c191`，预热、bind 成功后，仅通过该会话原生快捷键切到 `manual mode`，未改全局配置或其他会话。

测试目录：`/root/.botmux/tool-validation-20261115/dev-two`；外部写入目标：`/tmp/botmux-tools-permission-20261115/`（mode 700）。

### 允许分支（真人回调，通过）

- Ask ID：`95cda6b4-a67f-4726-914d-c9a4d90f4a0a`；卡片 message ID：`om_x100b60a784ba2ca0c0622aae2355ffa`。
- 用户本人（openId `ou_f033c5c6…b15bb`）在卡片上选择「允许执行」，卡片终态回读为「问题1：允许执行」并带操作人。
- `allowed.txt` 实际写入 38 字节，内容与随机标记 `ALLOW_625840097a5a41e991896c90f1389ef2` 逐字一致。
- trigger 结果 completed，Claude 如实报告 Write 成功。

### 拒绝分支（真人回调，通过）

- 第一次拒绝卡（Ask ID `61dbdf62-0557-4042-826d-00e39f1829da`，卡片 `om_x100b60a7964c68a4b071a972d3da732`）被误点为「允许执行」，该次不计入拒绝证据；误写的 `denied.txt` 已删除后重新发起。
- 第二次拒绝卡：Ask ID `375ace1a-5841-497b-95e0-3769befd20fb`；卡片 message ID `om_x100b60a7913f48a4b0b994c2bd72bb9`。
- 用户本人选择「拒绝」，卡片终态回读为「问题1：拒绝」并带操作人。
- `denied.txt` 始终不存在；Claude 报告「Write 被拒绝……未重试，未改用其他方式」，无绕过行为。

### 消息直达链接结论

- 飞书官方 AppLink 仅支持「打开聊天页面」协议（`/client/chat/open?openChatId=…`），不支持按 messageId 定位单条消息；此前手工拼接的 `/client/message/open?messageId=…` 属无效协议，客户端打开报「此页面无效」，已停止使用。
- 仓库内 `chatAppLink()`（`src/im/lark/lark-hosts.ts`）生成的聊天入口与产品会话状态中的 `feishuChatLink` 同源，是官方支持格式：[打开开发二号测试聊天](https://applink.feishu.cn/client/chat/open?openChatId=oc_b8abe6dc09b95cd4f7b71a927cc15b30)。
- 每张卡片发卡后均通过 botmux `sendUserMessage` 私聊通知用户，三条通知 message ID：`om_x100b60a7809948a10cf0109f40cb72d`、`om_x100b60a794f68ca0e7149eb7853adb1`、`om_x100b60a7af015d34e71793579ce80ca`，均回读确认送达；卡片本身也经 `getMessageDetail` 新鲜回读，类型为 interactive 且聊天 ID 一致。
- 链接有效性的机器验证边界：协议格式、会话归属（内部会话、bot 在群）、卡片消息存在性与通知送达均可机器验证；客户端内点击动作由用户本人完成。

## 完整性与收尾

最终 verify（2026-11-15 13:08 UTC+8）：

- 2459 条测试前已关闭会话记录的状态和原始行摘要未变；测试前存在的活跃会话仍保留。
- `bots.json`、全局配置、Dashboard 密钥及已纳入基线的 Claude/Codex/LLMbox 凭据和 Codex 配置摘要均未变（`changedGuardPaths: []`）。
- 10 个 bot 在线；权限 pending 清零。
- Claude 原生 transcript 含 3 次 Write 工具调用（allowed.txt 1 次、denied.txt 2 次），已与 Codex rollout 一并归档到私有证据目录，未写入版本库。
- 两个测试会话均已关闭。

工具验收证据目录：`/root/.botmux/tool-validation-20261115`（含权限卡回读、私聊通知记录、原生 transcript、verification 摘要）。

未覆盖项：全仓测试与此前受沙箱限制的签名测试本轮未重跑，需另换环境复跑。
