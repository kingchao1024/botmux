---
title: botmux 知识入口
created_at: 2026-11-15
updated_at: 2026-11-15
scope: botmux
owner: wangchao.2048
status: active
confidence: as-of-source
---

# botmux 知识入口

## 是什么

botmux 是飞书话题群与 AI 编程 CLI 之间的桥接：Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini 等 20+ 种）。

## 适用范围

- 覆盖领域：bridge 架构、daemon 与话题路由、CLI 进程生命周期、构建发布、安全与身份边界。
- 适合回答：话题怎么路由到 CLI、daemon 怎么起、构建怎么跑、为什么某条消息没被接住、改这块代码要注意什么。
- 不覆盖：被桥接的各个 AI CLI 自身的用法、与 botmux 无关的通用开发。
- 维护人：wangchao.2048（as-of-source，未逐项实时复核）。

## 推荐读取顺序

1. 先读本文件，确认问题落在适用范围内。
2. **`AGENTS.md`（研发导航）**——它本身是按需 overlay，先读完它的硬约束再动手。
3. `docs/agent/index.md`——按其索引只打开相关叶子页，不要整树加载。
4. 背景与设计取舍 → `CONTEXT.md`、`docs/adr/`、`docs/design/`。
5. 具体功能文档 → `docs/`（话题源策略、异步消息、codex 实例、dispatch 回执等）。
6. 实现 → `src/`（子进程必须走 `src/core/self-spawn.ts`）、`packages/`。
7. 站点与文档 → `docs-site/`。
8. 仍找不到依据时说明缺口，不补造结论。

## 内容索引

| 入口 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 研发导航与高风险硬约束（软链，上游完整文档附其后） |
| [README.md](README.md) | 项目定位与支持的 CLI 列表 |
| [README.en.md](README.en.md) | 英文说明 |
| [CONTEXT.md](CONTEXT.md) | 领域术语表 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程 |
| [SECURITY.md](SECURITY.md) | 安全策略 |
| [LOCAL_OVERLAY.md](LOCAL_OVERLAY.md) | 本地 overlay 说明 |
| [ROLE_PROFILE_PLAN.md](ROLE_PROFILE_PLAN.md) | 角色档案规划 |
| [docs/agent/](docs/agent/) | 按需加载的研发文档入口 |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [docs/design/](docs/design/) | 设计文档 |
| [docs/](docs/) | 功能文档（话题源策略、异步消息、codex 实例、dispatch 回执、约束调用等） |
| [docs-site/](docs-site/) | 文档站点（rspress） |
| [src/](src/) | 主实现 |
| [packages/](packages/) | 子包 |
| [plans/](plans/) | 计划文档 |
| [scripts/](scripts/) | 构建与工具脚本 |
| [build/](build/) | 构建产物与配置 |
| [examples/](examples/) | 示例 |
| [plugin/](plugin/) | 知识包接入层 |
| [install.sh](install.sh) | 安装脚本 |
| [bots.json.example](bots.json.example) | 机器人配置样例 |
| [package.json](package.json) | 依赖与脚本 |
| [bunfig.toml](bunfig.toml) | Bun 配置（版本固定 1.4.2） |
| [electron-builder.yml](electron-builder.yml) | 打包配置 |
| [ecosystem.config.cjs](ecosystem.config.cjs) | 进程托管配置 |

## 边界提醒

- 包内文档为该次提交状态；当前行为以代码与最新提交为准。
- commit、push、merge、release、delete 与生产动作均需单独授权，本文件不构成授权。
