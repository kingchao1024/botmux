#!/usr/bin/env python3
"""校验按需加载的 Agent 文档 overlay，不依赖第三方包。"""

from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
LEAVES = (
    "architecture.md",
    "specs.md",
    "plans.md",
    "quality.md",
    "reliability.md",
    "security.md",
)
REQUIRED_FRONTMATTER = (
    "title",
    "purpose",
    "owner",
    "last_reviewed",
    "source_of_truth",
)
MEMORY_BEGIN = "<!-- BEGIN: share-context-memory v1 -->"
MEMORY_END = "<!-- END: share-context-memory v1 -->"
MEMORY_REQUIREMENTS = (
    ("BotMux 不依赖 Trae hooks", "BotMux 无 Trae hooks 语义"),
    ("当前初始化命令轮不召回、不保存，也不回补旧会话", "配置轮跳过语义"),
    ("下一轮普通对话开始", "下一普通轮召回语义"),
    ("最多保留与当前任务直接相关的 3 条摘要", "最多 3 条精准召回语义"),
    ("zero-disk stdin 方式，仅保存最近 1 组 USER + ASSISTANT", "zero-disk personal 最近 1 组语义"),
    ("`/som`、`/save-mem` 仅在用户明确输入时写入 org", "org 仅显式 som/save-mem 语义"),
    ("原始旧 BotMux 会话继续作为证据保留，不自动导入", "旧会话不自动导入语义"),
    ("稳定项目知识应写入仓库文档", "稳定知识写仓库语义"),
)
REQUIRED_RULES = {
    "CLAUDE.md": (
        "禁止在 worktree 执行 install",
        "编译态子进程必须走 `src/core/self-spawn.ts`",
        "build 不会认领全局 CLI，也不改变 live daemon",
        "owner 身份按应用隔离并 fail-closed",
        "commit、push、merge、release、delete 与生产动作均需单独明确授权",
    ),
    "docs/agent/index.md": (
        "不得整树读取 `docs/agent/`",
        "当前请求与既有文档冲突时，以当前请求约束范围",
    ),
    "docs/agent/architecture.md": (
        "多个平台、CLI、backend 和会话类型",
        "追踪调用方后才能声称隔离",
    ),
    "docs/agent/quality.md": (
        "trustedDependencies",
        "绝不在 worktree 执行 `bun install`",
        "测试中 spawn TypeScript 子进程必须使用 `test/helpers/ts-runner.ts`",
        "公开 git 历史不得出现飞书真人名",
    ),
    "docs/agent/plans.md": (
        "实现与独立验收必须分离",
        "检查失败时如实报告证据，不得报完成",
    ),
    "docs/agent/reliability.md": (
        "不得用裸 `node` 启 daemon",
        "bun run switch:here && bun run daemon:restart",
        "不得手动修改 `package.json` 的 `version`",
    ),
    "docs/agent/security.md": (
        "跨 app 或新建 app 的 owner 优先使用完整邮箱、手机号或 `on_`",
        "创建 app 前只能转换 daemon 已认证的 current owner；其他 `ou_` 必须在创建前拒绝",
        "Dashboard onboarding、交互式 setup、scripted `setup add` 及以后新增入口全部复用 `src/setup/owner-identity.ts`",
        "目标 app 明确无效时 fail-closed，临时网络或 scope 错误仍是 inconclusive",
        "`applySessionOwnerEnv` 必须在可配置 env 合并后注入并冻结，bot/backend 配置不可覆盖；ownerless session 必须删除两个 owner 变量",
        "source `BOTMUX_OWNER_OPEN_ID=ou_*` 创建 target app 时被拒绝，并验证真人 owner 在目标 Bot 下可以 `canOperate`",
    ),
}


def read_text(path: Path, errors: list[str]) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        errors.append(f"无法读取 {path.relative_to(ROOT)}：文件不是有效 UTF-8")
        return ""
    except OSError as exc:
        errors.append(f"无法读取 {path.relative_to(ROOT)}：{exc}")
        return ""


def parse_frontmatter(path: Path, errors: list[str]) -> dict[str, str]:
    text = read_text(path, errors)
    lines = text.splitlines()
    if len(lines) < 3 or lines[0] != "---":
        errors.append(f"{path.relative_to(ROOT)}：frontmatter 必须以 --- 开始")
        return {}
    try:
        end = lines.index("---", 1)
    except ValueError:
        errors.append(f"{path.relative_to(ROOT)}：缺少 frontmatter 结束标记 ---")
        return {}

    values: dict[str, str] = {}
    for line in lines[1:end]:
        if ":" not in line:
            errors.append(f"{path.relative_to(ROOT)}：frontmatter 行无效 {line!r}")
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    return values


def check_required_rules(errors: list[str]) -> None:
    for relative_path, snippets in REQUIRED_RULES.items():
        path = ROOT / relative_path
        content = read_text(path, errors)
        for snippet in snippets:
            if snippet not in content:
                errors.append(f"{relative_path}：缺少关键约束 {snippet!r}")


def check_package_and_ci(errors: list[str]) -> None:
    package_path = ROOT / "package.json"
    package_text = read_text(package_path, errors)
    try:
        package = json.loads(package_text)
    except json.JSONDecodeError as exc:
        errors.append(f"package.json：不是有效 JSON：{exc}")
    else:
        if package.get("scripts", {}).get("check:agent") != "python3 scripts/agent_repo_check.py":
            errors.append("package.json：scripts.check:agent 必须执行 python3 scripts/agent_repo_check.py")

    check_ci_build_job(errors)


def check_ci_build_job(errors: list[str]) -> None:
    path = ROOT / ".github/workflows/ci.yml"
    lines = read_text(path, errors).splitlines()
    build_start = next((index for index, line in enumerate(lines) if re.match(r"^  build:\s*$", line)), None)
    if build_start is None:
        errors.append(".github/workflows/ci.yml：找不到 build job")
        return
    job_end = next(
        (index for index in range(build_start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[index])),
        len(lines),
    )
    build_lines = lines[build_start:job_end]
    check_lines = [index for index, line in enumerate(build_lines) if line.strip() == "- run: bun run check:agent"]
    build_lines_indices = [index for index, line in enumerate(build_lines) if line.strip() == "- run: bun run build"]
    if len(check_lines) != 1:
        errors.append(".github/workflows/ci.yml：build job 必须恰有一条未注释的 - run: bun run check:agent")
    if not build_lines_indices:
        errors.append(".github/workflows/ci.yml：build job 必须包含 - run: bun run build")
    elif check_lines and check_lines[0] > build_lines_indices[0]:
        errors.append(".github/workflows/ci.yml：check:agent 必须在 build job 的 bun run build 之前运行")


def check_agent_documents(errors: list[str]) -> None:
    agent_dir = ROOT / "docs/agent"
    index = agent_dir / "index.md"
    index_text = read_text(index, errors)
    documents = sorted(agent_dir.glob("*.md"))
    for path in documents:
        relative_path = path.relative_to(ROOT)
        values = parse_frontmatter(path, errors)
        for field in REQUIRED_FRONTMATTER:
            if not values.get(field):
                errors.append(f"{relative_path}：缺少 frontmatter 字段 {field}")
        value = values.get("last_reviewed", "")
        try:
            if dt.date.fromisoformat(value) > dt.date.today():
                errors.append(f"{relative_path}：last_reviewed 不能晚于当前日期")
        except ValueError:
            errors.append(f"{relative_path}：last_reviewed 必须是 ISO 日期 YYYY-MM-DD")
        if f"]({path.name})" not in index_text:
            errors.append(f"docs/agent/index.md 必须链接 {path.name}")


def main() -> int:
    errors: list[str] = []
    required = [ROOT / "CLAUDE.md", ROOT / "AGENTS.md", ROOT / "docs/agent/index.md"]
    required.extend(ROOT / "docs/agent" / leaf for leaf in LEAVES)
    required.append(ROOT / "scripts/agent_repo_check.py")
    for path in required:
        if not path.exists() and not path.is_symlink():
            errors.append(f"缺少必需文件：{path.relative_to(ROOT)}")

    agents = ROOT / "AGENTS.md"
    if agents.is_symlink():
        if os.readlink(agents) != "CLAUDE.md":
            errors.append("AGENTS.md 必须是指向 CLAUDE.md 的软链")
    else:
        errors.append("AGENTS.md 必须是指向 CLAUDE.md 的软链")

    claude = ROOT / "CLAUDE.md"
    claude_text = read_text(claude, errors)
    for required_text, explanation in (
        ("docs/agent/index.md", "指向 docs/agent/index.md"),
        ("bun run check:agent", "写明 bun run check:agent"),
    ):
        if required_text not in claude_text:
            errors.append(f"CLAUDE.md 必须 {explanation}")
    for marker in (MEMORY_BEGIN, MEMORY_END):
        count = claude_text.count(marker)
        if count != 1:
            errors.append(f"CLAUDE.md 必须且只能包含一个 {marker}")
    memory_start = claude_text.find(MEMORY_BEGIN)
    memory_end = claude_text.find(MEMORY_END)
    if memory_start > memory_end:
        errors.append("CLAUDE.md 记忆管理块的结束标记在开始标记之前")
    memory_block = claude_text[memory_start:memory_end] if memory_start >= 0 and memory_end >= 0 else ""
    for required_text, meaning in MEMORY_REQUIREMENTS:
        if required_text not in memory_block:
            errors.append(f"CLAUDE.md 记忆管理块必须保留：{meaning}")

    for leaf in LEAVES:
        if not (ROOT / "docs/agent" / leaf).is_file():
            errors.append(f"docs/agent：缺少必需叶子页 {leaf}")
    check_agent_documents(errors)

    pycache = ROOT / "scripts/__pycache__"
    if pycache.exists():
        errors.append("scripts/__pycache__ 不应存在；请清理生成的 Python 字节码")

    check_required_rules(errors)
    check_package_and_ci(errors)

    if errors:
        print("Agent 仓库检查失败：")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Agent 仓库检查通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
