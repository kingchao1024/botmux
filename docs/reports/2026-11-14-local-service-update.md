# 本机 Botmux 服务更新

状态：版本已对齐到 3.59.9，服务重启及运行验收通过。最近验收时间：2026-11-14 17:18（北京时间）。

本机 root 用户级 `botmux.service` 的 10 个机器人均回报 3.59.9，Dashboard 在线。旧产物与 systemd 配置已保留，可回滚。以下先记录 17:03 的构建部署，再记录版本号校准及 17:18 的重启验收。

17:03 的部署经用户授权，目标是 root 用户级 `botmux.service`，源码提交为 `a491b4c3fcb3ac95337b693efce89e09e752210a`，当时版本标记为 3.58.0。构建在独立 worktree 中执行，复用现有依赖。

更新前，supervisor PID 为 266794，10 个机器人和 Dashboard 均在线。旧运行时为 Bun 1.4.2，旧产物 `.runtime-build-id` 为 `c78aa92a1b2d5c05474cba63c1c215668faaf0d7b03acbcea5b2dd2d0c6fee57`。

部署时保留旧 dist 和 systemd 配置备份，安装服务专用 Bun 1.4.4，通过 root 用户 systemd manager 重启。验收覆盖实际进程、版本、cgroup、飞书连接、Dashboard HTTP 和会话存储。

候选构建的 emit、typecheck、Dashboard bundle、public-domain audit、dist audit 和 embedded-assets audit 均通过，退出码 0。使用现有 TypeScript 5.9 fallback；未安装依赖。由于本机 `bun run` 的 shell 调用返回 127，改由 `/bin/sh` 执行 package.json 定义的相同步骤；没有更改构建配置。

候选 runtime build id 为 `e17e38d16e58d516fc052abbb792c3f98aca52534a1030dc306d453d17f0b665`，与先前已验收的 fresh worker 构建一致。`dist/cli.js` SHA-256 为 `d21d019c99b468dda9c0a238696c4190b030abac8078e18b7a08567983067e2a`；`dist/worker.js` 为 `a0f43c5703755393a7c38fe7759b3925ba15f364cc3373f67cc7d0d2a94b67ba`。

启动预检：10/10 飞书凭据有效，SQLite 引擎和真实宿主凭据读取路径通过，无 quota-fallback 环路或已退役 CLI。10 个会话库共保存 2397 条会话，当前 active 行为 0；候选源码的只读会话快照也返回 2397 条。部署前仓库发布屏障为 open，无 writer lease，源码和候选均无已跟踪文件差异。

回滚目录：`/data00/home/root/workspaces/botmux-local-service-rollback-a491b4c3f-20261114`，由 root 持有，权限 0700。其中保存旧 dist、systemd unit/dropins、更新前进程和会话标识，以及本次预检与部署记录。服务专用运行时位于 `/root/.local/lib/botmux/bun-1.4.4/bun`。

第一次切换后，新 supervisor 和全部 daemon 已启动，日志记录了 Bun 1.4.4 下的真实 WebSocket 连接成功。但验收脚本要求 daemon 描述符的 `larkConnection.state` 为 connected；当前 `src/daemon.ts` 没有将此状态写入描述符，导致 90 秒等待超时。脚本于 17:00:40（北京时间）开始自动回滚，17:00:43 恢复旧 dist 和旧运行时，10 个机器人及 Dashboard 均重新在线。第一轮记录保存在 `attempt-1-rolled-back.json`。

第二轮验收改为核对当前 PID 对应的启动日志中的 WebSocket connected 记录、该 PID 持有的外部 ESTABLISHED socket、真实运行时路径，以及 authenticated daemon IPC。没有修改生产源码、描述符或业务配置。描述符缺失连接状态仍是观测限制，后续实时连接状态不能仅依赖该字段。

第二轮于 17:02:34 停止旧 fleet 并切换 dist，17:02:37 systemd 启动命令成功退出，17:02:44 完成运行验收，部署记录为 `phase: verified`。supervisor PID 为 3382497，Dashboard PID 为 3382786。

| 机器人 | 新 PID | 会话数 | 运行验收 |
|---|---:|---:|---|
| botmux-0 | 3382609 | 740 | 通过 |
| botmux-readonly-diagnosis | 3382616 | 905 | 通过 |
| botmux-docs-report | 3382634 | 87 | 通过 |
| botmux-implementation-builder | 3382650 | 121 | 通过 |
| botmux-review-validation | 3382667 | 296 | 通过 |
| botmux-a2a-platform-assistant | 3382687 | 63 | 通过 |
| botmux-dev-one | 3382697 | 84 | 通过 |
| botmux-dev-two | 3382724 | 14 | 通过 |
| botmux-dev-three | 3382745 | 76 | 通过 |
| botmux-review-validation-2 | 3382767 | 11 | 通过 |

每个机器人均回报 3.58.0，进程重启计数为 0，启动日志记录了本轮 PID 的真实 WebSocket connected，且进程持有外部 ESTABLISHED socket；10 个 daemon 的签名鉴权 IPC `/api/sessions` 均返回 HTTP 200。supervisor、10 个 daemon 和 Dashboard 的实际 executable 均为服务专用 Bun 1.4.4，cgroup 均归属 `botmux.service`。

Dashboard `/__health`、带 Cookie 鉴权的 `/api/bots`、`/api/sessions` 和 `/api/dashboard/v1/summary` 均返回 HTTP 200。机器人列表为 10 个、会话列表为 2397 条，summary 的 service.status 为 healthy。

17:03 独立回读确认：10 个会话库的会话标识无缺失，状态变化为 0，总数仍为 2397；bots.json、数据目录配置、dashboard secret 和设备绑定文件的哈希保持更新前值。10 个 daemon 描述符的 `runtimeGeneration` 均与新 dist 的 runtime build id 一致。新 CLI/worker 哈希与候选一致，回滚副本的 CLI/worker 哈希与更新前一致。

运行证据保存在回滚目录的 `deployment.json`、`verify.json`、`after-integrity.json`；执行过的部署和验收脚本作为审计副本保留。构建 worktree 和本轮工作区临时脚本已清理。该次部署的源码提交为 `a491b4c3f`，五份 stash 和既有未跟踪稿保留。

此前主回归 920 个、输出链路回归 355 个通过；源码和新构建 worker 各 9/9 通过。15 个凭据隔离用例受当前沙箱限制未完成，扩展检查的既有失败详见公共上游合并报告。本次更新不等于全树测试通过。

启动日志仍有历史 workflow 的进度卡超过飞书 14 天编辑期限、旧 run.json 缺失的告警；这些记录未做清理。signed receipt authority 的 marker_missing 提示也保持原状，没有启用或放宽安全开关。

真实飞书消息投递和 Ask 回调需要后续实际使用验证，本次没有主动发送验收消息，回滚副本在这些验证完成前保留。

后续版本号校准：按用户新增的 public 版本来源约定，将仓库 `package.json.version` 从 3.58.0 对齐到 3.59.9。远程 `deepcoldy/botmux` 的 annotated tag `v3.59.9` 对象为 `a8741ac10c2e1800ed597ea0c9f1a9a108fa9d69`，其 peeled commit 为 `f0b3a0e72587d3e7720781f67d61b0508d9b4168`，与本轮已合入的 public 提交完全一致。远程最新正式 tag 为 v3.59.12，其代码尚未合入，不用于本次版本号。

版本号校准时只修改版本元数据，没有重建 dist 或重启服务。上文的 3.58.0 是 17:03 部署时回读到的版本标记。随后按用户授权执行了下面的提交、推送和服务重启。

版本来源约定、3.59.9 校准及本报告已纳入提交 `488c453fc262da9cc9f90a05726e7f5cb26a8024`，推送到 origin/master 与 upstream/master；两端 `ls-remote` 独立回读均为该提交。重启前已跟踪文件无改动，发布屏障为 open，无 writer lease。

本轮生产源码没有行为变更，复用 17:03 已验收的 dist，CLI/worker SHA-256 和 runtime build id 保持上述值。启动预检再次确认 10/10 凭据有效、SQLite 和宿主凭据读取通过。通过 root 用户 systemd manager 执行 `systemctl --user restart botmux.service`，没有从 Agent 会话直接启动 supervisor。

17:18:22 验收通过：supervisor PID 从 3382497 变为 3435242，Dashboard PID 从 3382786 变为 3435478。10 个 daemon 均为 online、版本 3.59.9、重启计数 0；supervisor、全部 daemon 和 Dashboard 均使用服务专用 Bun 1.4.4，cgroup 归属 botmux.service。当前 PID 的 WebSocket connected 日志和外部 ESTABLISHED socket 均已核对，10 个签名鉴权 IPC `/api/sessions` 均返回 HTTP 200。

Dashboard 的健康、机器人列表、会话列表和 summary 接口均返回 HTTP 200，列表为 10 个机器人、2397 条会话，service.status 为 healthy。逐库回读确认全部会话标识和状态与重启前一致，配置及凭据文件哈希不变；10 个 daemon 的 runtimeGeneration 均为 `e17e38d16e58d516fc052abbb792c3f98aca52534a1030dc306d453d17f0b665`。

本轮证据保存于 `/data00/home/root/workspaces/botmux-local-service-restart-488c453fc-20261114`，目录由 root 持有，权限 0700，包含 `before.json`、`preflight.json`、`verify.json` 和 `after-integrity.json`。旧版本回滚目录、五份 stash 和既有未跟踪稿保留；真实飞书消息与 Ask 回调的验收边界仍按上文执行。
