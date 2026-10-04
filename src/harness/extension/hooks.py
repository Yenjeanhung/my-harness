"""生命周期 Hooks（DESIGN.md §4.10）：配置声明的 shell 命令，覆盖工具执行前后。

约定（对齐 Claude Code）：
- 命令经 stdin 收到 JSON 载荷（event/tool/args/session_id…）；
- exit code 2 = 阻断；stdout 可输出 JSON `{"decision": "block", "reason": "..."}` 同样阻断；
- 其余退出码视为放行。硬安全规则应走权限引擎，hooks 是软扩展（best-effort）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pydantic import BaseModel


class HookResult(BaseModel):
    blocked: bool = False
    reason: str = ""


class HookManager:
    def __init__(self, commands: dict[str, list[str]] | None = None, timeout: int = 30):
        self._hooks = {k.strip().lower(): list(v) for k, v in (commands or {}).items()}
        self.timeout = timeout

    def has(self, event: str) -> bool:
        return bool(self._hooks.get(event))

    async def _run(self, event: str, payload: dict[str, Any]) -> HookResult:
        stdin_data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        for cmd in self._hooks.get(event, []):
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                out, err = await asyncio.wait_for(proc.communicate(stdin_data), timeout=self.timeout)
            except TimeoutError:
                proc.kill()
                raise RuntimeError(f"hook timed out after {self.timeout}s: {cmd}")
            if proc.returncode == 2:
                reason = (err or out).decode("utf-8", errors="replace").strip()
                return HookResult(blocked=True, reason=reason or f"blocked by hook: {cmd}")
            try:
                data = json.loads(out.decode("utf-8", errors="replace") or "{}")
                if data.get("decision") == "block":
                    return HookResult(blocked=True, reason=data.get("reason") or f"blocked by hook: {cmd}")
            except json.JSONDecodeError:
                pass
        return HookResult()

    async def pre_tool(self, tool: str, args: dict[str, Any], session_id: str) -> HookResult:
        return await self._run(
            "pre_tool_use", {"event": "pre_tool_use", "tool": tool, "args": args, "session_id": session_id}
        )

    async def post_tool(self, tool: str, is_error: bool, chars: int, session_id: str) -> HookResult:
        return await self._run(
            "post_tool_use",
            {"event": "post_tool_use", "tool": tool, "is_error": is_error, "chars": chars, "session_id": session_id},
        )
