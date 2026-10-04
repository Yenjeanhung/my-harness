"""工具注册表与执行管道（DESIGN.md §4.3）：超时 → 执行 → 错误消息写给 agent → 截断。"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field

from ..core.messages import ToolResultBlock

MAX_RESULT_CHARS = 50_000  # ≈25K token，对齐 Claude Code 的工具结果上限

Handler = Callable[[dict[str, Any], "ToolContext"], Awaitable[str]]


class ToolContext(BaseModel):
    workspace_root: Any  # Path
    data_dir: Any  # Path
    session_id: str = ""  # 当前会话（/new 或子代理派生时更新）
    # 记忆（M2）：由 CLI/server 按会话装配；测试可留 None
    vault: Any = None  # MemoryVault
    blocks: Any = None  # BlockStore（当前会话的短期记忆）
    event_store: Any = None  # EventStore（情景检索）
    skills: Any = None  # SkillRegistry


class ToolSpec(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int = 120
    read_only: bool = False


class Tool:
    def __init__(self, spec: ToolSpec, handler: Handler):
        self.spec = spec
        self.handler = handler


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.spec.name] = tool

    def specs(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.spec.name,
                    "description": t.spec.description,
                    "parameters": t.spec.parameters,
                },
            }
            for t in self._tools.values()
        ]

    def is_read_only(self, name: str) -> bool:
        tool = self._tools.get(name)
        return bool(tool and tool.spec.read_only)

    def clone_without(self, names: set[str]) -> "ToolRegistry":
        """克隆一份去掉指定工具的注册表（用于 subagent 深度限制）。"""
        reg = ToolRegistry()
        reg._tools = {k: v for k, v in self._tools.items() if k not in names}
        return reg

    def remove_prefix(self, prefix: str) -> int:
        """移除所有指定前缀的工具（用于断开某个 MCP server）。"""
        names = [k for k in self._tools if k.startswith(prefix)]
        for k in names:
            del self._tools[k]
        return len(names)

    async def execute(
        self, name: str, args: dict[str, Any], *, tool_use_id: str, ctx: ToolContext
    ) -> ToolResultBlock:
        tool = self._tools.get(name)
        if tool is None:
            return ToolResultBlock(
                tool_use_id=tool_use_id,
                content=f"Unknown tool: {name}. Available: {', '.join(sorted(self._tools))}",
                is_error=True,
            )
        try:
            content = await asyncio.wait_for(
                tool.handler(args, ctx), timeout=tool.spec.timeout_seconds
            )
        except TimeoutError:
            content = f"Tool '{name}' timed out after {tool.spec.timeout_seconds}s. Try a narrower operation."
            return ToolResultBlock(tool_use_id=tool_use_id, content=content, is_error=True)
        except Exception as e:  # 错误消息写给 agent：具体、可执行
            content = f"{type(e).__name__}: {e}"
            return ToolResultBlock(tool_use_id=tool_use_id, content=content, is_error=True)
        if len(content) > MAX_RESULT_CHARS:
            content = content[:MAX_RESULT_CHARS] + (
                f"\n\n[truncated: result exceeded {MAX_RESULT_CHARS} chars. "
                "Repeat the call with narrower parameters (offset/limit/grep) instead.]"
            )
        return ToolResultBlock(tool_use_id=tool_use_id, content=content)
