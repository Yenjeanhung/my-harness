"""内置工具集（M0）：bash / read_file / write_file / edit_file / glob / grep。

设计对齐 DESIGN.md §4.3.1（ACI 准则）：路径限定在工作区内、编辑带 lint 式回拒、
受限查看器、空输出回执。Windows 下 bash 工具默认走 PowerShell。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .base import Tool, ToolContext, ToolRegistry, ToolSpec

_SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache"}


def _resolve(ctx: ToolContext, path: str) -> Path:
    root = Path(ctx.workspace_root).resolve()
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = root / p
    p = p.resolve()
    if not p.is_relative_to(root):
        raise ValueError(
            f"path '{path}' escapes workspace root '{root}'. Use a path inside the workspace."
        )
    return p


def _rel(ctx: ToolContext, p: Path) -> str:
    try:
        return str(p.relative_to(Path(ctx.workspace_root).resolve()))
    except ValueError:
        return str(p)


# —— bash ——
def _make_bash(sandbox=None):
    async def _bash(args: dict[str, Any], ctx: ToolContext) -> str:
        command = args["command"]
        timeout = int(args.get("timeout", 120))
        if sandbox is not None:
            code, text = await sandbox.run(command, ctx.workspace_root, timeout=timeout)
            if not text.strip():
                text = "[empty output]\n"
            return f"exit_code={code}\n{text}"
        if sys.platform == "win32":
            cmd = ["powershell", "-NoProfile", "-Command", command]
        else:
            cmd = ["/bin/bash", "-lc", command]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(Path(ctx.workspace_root).resolve()),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            proc.kill()
            return f"Command timed out after {timeout}s and was killed."
        text = out.decode("utf-8", errors="replace")
        if len(text) > 30_000:
            text = text[:30_000] + "\n[output truncated]"
        if not text.strip():
            text = "[empty output]\n"
        return f"exit_code={proc.returncode}\n{text}"

    return _bash


# —— read_file ——
async def _read_file(args: dict[str, Any], ctx: ToolContext) -> str:
    p = _resolve(ctx, args["path"])
    if not p.exists():
        raise FileNotFoundError(f"{p} does not exist")
    if p.stat().st_size > 1_000_000:
        raise ValueError(
            f"{_rel(ctx, p)} is larger than 1MB. Use offset/limit, or grep to locate content."
        )
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    offset = max(int(args.get("offset", 1)), 1)
    limit = min(int(args.get("limit", 2000)), 2000)
    chunk = lines[offset - 1 : offset - 1 + limit]
    if not chunk:
        return f"[empty range: file has {len(lines)} lines]"
    numbered = "\n".join(f"{offset + i:>6}\t{line}" for i, line in enumerate(chunk))
    if offset - 1 + limit < len(lines):
        numbered += f"\n[{len(lines) - (offset - 1 + limit)} more lines. Continue with offset={offset + limit}]"
    return numbered


# —— write_file ——
async def _write_file(args: dict[str, Any], ctx: ToolContext) -> str:
    p = _resolve(ctx, args["path"])
    content = args["content"]
    p.parent.mkdir(parents=True, exist_ok=True)
    existed = p.exists()
    p.write_text(content, encoding="utf-8")
    action = "overwrote" if existed else "created"
    return f"ok: {action} {_rel(ctx, p)} ({len(content)} chars)"


# —— edit_file ——
async def _edit_file(args: dict[str, Any], ctx: ToolContext) -> str:
    p = _resolve(ctx, args["path"])
    old, new = args["old_str"], args["new_str"]
    text = p.read_text(encoding="utf-8")
    n = text.count(old)
    if n == 0:
        raise ValueError("old_str not found in file. Read the file again and copy the exact text.")
    if n > 1:
        raise ValueError(
            f"old_str occurs {n} times; include more surrounding lines to make it unique."
        )
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    return f"ok: edited {_rel(ctx, p)}"


# —— glob ——
async def _glob(args: dict[str, Any], ctx: ToolContext) -> str:
    root = Path(ctx.workspace_root).resolve()
    pattern = args.get("pattern", "**/*")
    hits = [
        _rel(ctx, p)
        for p in sorted(root.glob(pattern))
        if p.is_file() and not any(part in _SKIP_DIRS for part in p.parts)
    ]
    if not hits:
        return "[no matches]"
    if len(hits) > 200:
        hits = hits[:200] + [f"[{len(hits) - 200} more truncated]"]
    return "\n".join(hits)


# —— grep ——
async def _grep(args: dict[str, Any], ctx: ToolContext) -> str:
    root = Path(ctx.workspace_root).resolve()
    rx = re.compile(args["pattern"])
    glob = args.get("glob", "**/*")
    matches: list[str] = []
    scanned = 0
    for p in root.glob(glob):
        if not p.is_file() or any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.stat().st_size > 1_000_000:
            continue
        scanned += 1
        try:
            for i, line in enumerate(
                p.read_text(encoding="utf-8", errors="replace").splitlines(), 1
            ):
                if rx.search(line):
                    matches.append(f"{_rel(ctx, p)}:{i}: {line.strip()[:200]}")
                    if len(matches) >= 100:
                        matches.append("[100 matches truncated. Refine the pattern.]")
                        return "\n".join(matches)
        except OSError:
            continue
    if not matches:
        return f"[no matches for pattern '{args['pattern']}' in {scanned} files]"
    return "\n".join(matches)


def _spec(name: str, description: str, properties: dict, required: list, **kw) -> Tool:
    return Tool(
        ToolSpec(
            name=name,
            description=description,
            parameters={"type": "object", "properties": properties, "required": required},
            **kw,
        ),
        globals()[f"_{name}"],
    )


def build_default_registry(sandbox=None) -> ToolRegistry:
    reg = ToolRegistry()
    bash_desc = (
        "Run a shell command and return its exit code and combined output. "
        + (
            "Executes inside the harness Docker sandbox: workspace mounted at /workspace, "
            "network disabled by default."
            if sandbox is not None
            else "On Windows this uses PowerShell; on Unix, bash."
        )
    )
    reg.register(
        Tool(
            ToolSpec(
                name="bash",
                description=bash_desc,
                parameters={"type": "object", "properties": {"command": {"type": "string"}, "timeout": {"type": "integer"}}, "required": ["command"]},
                timeout_seconds=180,
            ),
            _make_bash(sandbox),
        )
    )
    reg.register(
        _spec(
            "read_file",
            "Read a text file from the workspace, returned as numbered lines. "
            "Large files: use offset/limit windows (max 2000 lines per call).",
            {
                "path": {"type": "string"},
                "offset": {"type": "integer"},
                "limit": {"type": "integer"},
            },
            ["path"],
            read_only=True,
        )
    )
    reg.register(
        _spec(
            "write_file",
            "Create or overwrite a file inside the workspace with the given content.",
            {"path": {"type": "string"}, "content": {"type": "string"}},
            ["path", "content"],
        )
    )
    reg.register(
        _spec(
            "edit_file",
            "Replace one exact occurrence of old_str with new_str in a workspace file. "
            "Fails if old_str is missing or not unique (lint-reject: copy the exact text from read_file).",
            {
                "path": {"type": "string"},
                "old_str": {"type": "string"},
                "new_str": {"type": "string"},
            },
            ["path", "old_str", "new_str"],
        )
    )
    reg.register(
        _spec(
            "glob",
            "List files in the workspace matching a glob pattern (e.g. 'src/**/*.py'). Returns paths only.",
            {"pattern": {"type": "string"}},
            [],
            read_only=True,
        )
    )
    reg.register(
        _spec(
            "grep",
            "Search file contents with a regex across the workspace; returns up to 100 'path:line: text' matches.",
            {"pattern": {"type": "string"}, "glob": {"type": "string"}},
            ["pattern"],
            read_only=True,
        )
    )
    return reg
