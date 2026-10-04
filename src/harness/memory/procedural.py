"""程序性记忆：AGENT.md 三层发现（全局 + 项目；DESIGN.md §4.4，学 CLAUDE.md/GEMINI.md）。"""

from __future__ import annotations

from pathlib import Path


def load_agent_md(workspace_root: Path, data_dir: Path) -> str:
    """全局 ~/.my-harness/AGENT.md + 项目 <workspace>/AGENT.md，按序拼接。"""
    parts: list[str] = []
    candidates = [
        (Path(data_dir) / "AGENT.md", "global"),
        (Path(workspace_root).resolve() / "AGENT.md", "project"),
    ]
    for p, scope in candidates:
        if p.exists() and p.is_file():
            text = p.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                parts.append(f"## {scope.capitalize()} instructions ({p})\n\n{text}")
    return "\n\n".join(parts)
