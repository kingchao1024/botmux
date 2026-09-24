---
title: 安全边界
purpose: 保留 app-scoped owner 身份与 fail-closed setup 硬不变量。
owner: maintainers
last_reviewed: 2026-09-22
source_of_truth: src/setup/owner-identity.ts、setup/onboarding 调用方与对应测试。
---

# 安全边界

以下均为硬不变量，不是建议。

- `ou_` open ID 按 app 隔离，不能跨 app 复用。跨 app 或新建 app 的 owner 优先使用完整邮箱、手机号或 `on_`。
- 创建 app 前只能转换 daemon 已认证的 current owner；其他 `ou_` 必须在创建前拒绝。
- Dashboard onboarding、交互式 setup、scripted `setup add` 及以后新增入口全部复用 `src/setup/owner-identity.ts`，不能只做格式校验后直接写 `allowedUsers`。
- 写 `bots.json` 前必须对目标 app 校验 owner；目标 app 明确无效时 fail-closed，临时网络或 scope 错误仍是 inconclusive。
- `BOTMUX_OWNER_OPEN_ID` 与 `__OWNER_OPEN_ID` 是 daemon 已认证的 session 身份。`applySessionOwnerEnv` 必须在可配置 env 合并后注入并冻结，bot/backend 配置不可覆盖；ownerless session 必须删除两个 owner 变量。
- 回归必须覆盖 managed-Agent：source `BOTMUX_OWNER_OPEN_ID=ou_*` 创建 target app 时被拒绝，并验证真人 owner 在目标 Bot 下可以 `canOperate`。

格式校验、Bot-to-Bot 可投递或 scope 存在，均不能证明 owner 在目标 app 中有效。
