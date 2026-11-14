#!/usr/bin/env python3
"""Trae hook for BotMux skill preflight and share-context-memory automation."""

from __future__ import annotations

import datetime as dt
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

MEMORY_BACKOFF_SECONDS = 300


def safe_session_id(value: str) -> str | None:
    value = value.strip()
    return value if re.fullmatch(r"[A-Za-z0-9._-]{1,200}", value) else None


def data_dir() -> Path:
    return Path(os.environ.get("SESSION_DATA_DIR") or Path.home() / ".botmux" / "data")


def manifest(session_id: str) -> dict[str, Any] | None:
    try:
        value = json.loads((data_dir() / "skill-manifests" / f"{session_id}.json").read_text("utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def priority_names(value: dict[str, Any]) -> set[str]:
    skills = value.get("prioritySkills")
    if not isinstance(skills, list):
        return set()
    return {
        item["name"] for item in skills
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }


def enabled_for_manifest(value: dict[str, Any]) -> bool:
    cutoff = data_dir() / "skill-runtime-enabled-at"
    if not cutoff.is_file():
        return True
    try:
        enabled_at = cutoff.read_text("utf-8").strip()
        generated_at = value.get("generatedAt")
        return isinstance(generated_at, str) and generated_at >= enabled_at
    except Exception:
        return False


def state_path(session_id: str) -> Path:
    return data_dir() / "skill-preflight" / f"{session_id}.json"


def memory_backoff_path() -> Path:
    return data_dir() / "memory-hook-backoff.json"


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write("\n")
        os.replace(temp, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def append_audit(session_id: str, action: str, outcome: str) -> None:
    try:
        path = Path(os.environ.get("BOTMUX_SKILL_INVOCATION_AUDIT_PATH") or data_dir() / "audit" / "skill-invocations.ndjson")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        record = {
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "sessionId": session_id,
            "larkAppId": os.environ.get("BOTMUX_LARK_APP_ID", "unknown"),
            "action": action,
            "skill": "share-context-memory" if action.startswith("auto-") else "preflight",
            "outcome": outcome,
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(path, 0o600)
    except Exception:
        pass


def memory_is_backing_off() -> bool:
    try:
        value = json.loads(memory_backoff_path().read_text("utf-8"))
        return float(value.get("retryAfterEpoch", 0)) > dt.datetime.now().timestamp()
    except Exception:
        return False


def update_memory_backoff(failed: bool) -> None:
    path = memory_backoff_path()
    if not failed:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    try:
        write_json_atomic(path, {
            "version": 1,
            "retryAfterEpoch": dt.datetime.now().timestamp() + MEMORY_BACKOFF_SECONDS,
        })
    except Exception:
        pass


def extract_user_message(prompt: str) -> str:
    matches = re.findall(r"<user_message>\s*(.*?)\s*</user_message>", prompt, flags=re.DOTALL)
    return html.unescape(matches[-1]).strip() if matches else prompt.strip()


def is_pure_memory_command(text: str) -> bool:
    return re.fullmatch(
        r"/(?:save-mem|spm|som|save-personal|scm-status|add-mem-hook|check-mem-hook|remove-mem-hook|init-mem|check-mem-init)(?:\s+\S+)?\s*",
        text,
    ) is not None


def memory_script() -> Path | None:
    override = os.environ.get("BOTMUX_MEMORY_SCRIPT", "").strip()
    if override:
        path = Path(override)
        return path if path.is_file() else None
    try:
        registry = json.loads((Path.home() / ".botmux" / "skills" / "registry.json").read_text("utf-8"))
        root = registry["skills"]["share-context-memory"]["rootDir"]
        path = Path(root) / "scripts" / "openclaw_memory.py"
        return path if path.is_file() else None
    except Exception:
        return None


def run_memory(
    script: Path,
    args: list[str],
    stdin: str | None = None,
    timeout: float = 8,
) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            [sys.executable, str(script), *args],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return None


def write_hook_output(event: str, **values: Any) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, **values}}, ensure_ascii=False))


def on_user_prompt(payload: dict[str, Any], session_id: str, names: set[str]) -> None:
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return
    current = state_path(session_id)
    if not current.exists() and names:
        try:
            write_json_atomic(current, {
                "version": 1,
                "sessionId": session_id,
                "status": "pending",
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            })
        except Exception:
            pass

    if "share-context-memory" not in names:
        return
    user_text = extract_user_message(prompt)
    if not user_text or is_pure_memory_command(user_text):
        return
    try:
        pending = data_dir() / "memory-hook-pending" / f"{session_id}.json"
        write_json_atomic(pending, {"user": user_text, "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat()})
    except Exception:
        pass

    recalled = ""
    if not memory_is_backing_off():
        script = memory_script()
        result = run_memory(
            script,
            ["search", "--query", user_text, "--top-k", "5", "--format", "prepend", "--prepend-style", "compact"],
            timeout=3,
        ) if script else None
        ok = result is not None and result.returncode == 0
        update_memory_backoff(not ok)
        append_audit(session_id, "auto-recall", "ok" if ok else "error")
        recalled = result.stdout.strip()[:32768] if ok else ""
    managed = "<share_context_memory managed=\"hook\">Auto recall and personal save are managed for this turn; do not invoke them manually."
    if recalled:
        managed += f"\n{recalled}"
    managed += "\n</share_context_memory>"
    write_hook_output("UserPromptSubmit", additionalContext=managed)


def on_pre_tool(payload: dict[str, Any], session_id: str, names: set[str]) -> None:
    if not names:
        return
    try:
        state = json.loads(state_path(session_id).read_text("utf-8"))
    except Exception:
        return
    if state.get("status") != "pending":
        return
    raw_input = json.dumps(payload.get("tool_input"), ensure_ascii=False)
    if re.search(r"\bbotmux\s+skill\s+show\s+[A-Za-z0-9_.:-]+", raw_input):
        return
    append_audit(session_id, "preflight-deny", "error")
    write_hook_output(
        "PreToolUse",
        permissionDecision="deny",
        permissionDecisionReason=(
            "Skill preflight is required before the first task tool. Run one separate "
            "`botmux skill show <matching-skill>` command, read it fully, then retry."
        ),
    )


def on_stop(payload: dict[str, Any], session_id: str, names: set[str]) -> None:
    if "share-context-memory" not in names:
        return
    text = payload.get("text_content")
    if not isinstance(text, str) or not text.strip():
        return
    pending = data_dir() / "memory-hook-pending" / f"{session_id}.json"
    try:
        saved = json.loads(pending.read_text("utf-8"))
        user = saved.get("user")
    except Exception:
        return
    if not isinstance(user, str) or not user:
        return
    if memory_is_backing_off():
        return
    transcript = f"=== USER ===\n{user}\n\n=== ASSISTANT ===\n{text}\n"
    script = memory_script()
    result = run_memory(script, ["save", "--scope", "personal", "--stdin"], transcript) if script else None
    ok = result is not None and result.returncode == 0
    update_memory_backoff(not ok)
    append_audit(session_id, "auto-save", "ok" if ok else "error")
    if ok:
        try:
            pending.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            return 0
        session_id = safe_session_id(os.environ.get("BOTMUX_SESSION_ID", ""))
        if not session_id:
            return 0
        current = manifest(session_id)
        if current is None or not enabled_for_manifest(current):
            return 0
        names = priority_names(current)
        event = payload.get("hook_event_name")
        if event == "UserPromptSubmit":
            on_user_prompt(payload, session_id, names)
        elif event == "PreToolUse":
            on_pre_tool(payload, session_id, names)
        elif event == "Stop":
            on_stop(payload, session_id, names)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
