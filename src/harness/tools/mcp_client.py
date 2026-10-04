"""MCP 客户端（DESIGN.md §4.3.3）：stdio + Streamable HTTP 双传输，工具命名空间 `mcp__<server>__<tool>`。

设计要点：长生命周期连接由后台任务持有上下文栈（close 时取消）；单 server 失败不阻塞
其余（connect_all 返回 warnings）；工具注解 readOnlyHint 映射为 read_only（决定权限闸行为）。
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from typing import Any

from .base import Tool, ToolSpec

START_TIMEOUT = 30
CALL_TIMEOUT = 60


class MCPConnection:
    def __init__(
        self,
        name: str,
        command: str | None = None,
        args: list[str] | None = None,
        env: dict | None = None,
        url: str | None = None,
    ):
        if not command and not url:
            raise ValueError(f"MCP server '{name}': need 'command' (stdio) or 'url' (http)")
        self.name = name
        self.command = command
        self.args = args or []
        self.env = env
        self.url = url
        self.session: Any = None
        self.error: Exception | None = None
        self._task: asyncio.Task | None = None
        self._ready: asyncio.Event | None = None

    async def start(self) -> None:
        from mcp import ClientSession

        self._ready = asyncio.Event()
        if self.url:
            from mcp.client.streamable_http import streamable_http_client

            self._task = asyncio.create_task(self._run(streamable_http_client(self.url), ClientSession))
        else:
            from mcp import StdioServerParameters
            from mcp.client.stdio import stdio_client

            params = StdioServerParameters(command=self.command, args=self.args, env=self.env)
            self._task = asyncio.create_task(self._run(stdio_client(params), ClientSession))
        await asyncio.wait_for(self._ready.wait(), timeout=START_TIMEOUT)
        if self.error:
            raise RuntimeError(f"MCP server '{self.name}' failed to start: {self.error}") from self.error

    async def _run(self, transport_cm, client_session_cls) -> None:
        try:
            async with AsyncExitStack() as stack:
                entered = await stack.enter_async_context(transport_cm)
                read, write = entered[0], entered[1]  # stdio 2 元组 / http 3 元组，兼容取前两项
                session = await stack.enter_async_context(client_session_cls(read, write))
                await session.initialize()
                self.session = session
                self._ready.set()
                await asyncio.Event().wait()  # 挂起保持连接存活，直到 close()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.error = e
            if self._ready:
                self._ready.set()

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
            self.session = None

    def make_tool(self, raw_name: str, description: str, schema: dict | None, read_only: bool) -> Tool:
        async def handler(args: dict, ctx) -> str:
            if self.session is None:
                raise RuntimeError(f"MCP server '{self.name}' is not connected")
            result = await asyncio.wait_for(self.session.call_tool(raw_name, args), timeout=CALL_TIMEOUT)
            parts = []
            for c in result.content or []:
                text = getattr(c, "text", None)
                parts.append(text if text is not None else str(getattr(c, "type", "content")))
            text = "\n".join(parts)
            if getattr(result, "isError", False):
                raise RuntimeError(text or f"tool '{raw_name}' failed")
            return text or "[empty output]"

        return Tool(
            ToolSpec(
                name=f"mcp__{self.name}__{raw_name}",
                description=description or f"MCP tool '{raw_name}' from server '{self.name}'",
                parameters=schema or {"type": "object", "properties": {}},
                read_only=read_only,
                timeout_seconds=CALL_TIMEOUT + 10,
            ),
            handler,
        )


async def collect_tools(connection: MCPConnection) -> list[Tool]:
    listing = await connection.session.list_tools()
    tools = []
    for t in listing.tools:
        read_only = bool(getattr(getattr(t, "annotations", None), "readOnlyHint", False))
        tools.append(connection.make_tool(t.name, t.description, getattr(t, "inputSchema", None), read_only))
    return tools


async def connect_all(servers: dict[str, dict]) -> tuple[list[Tool], list[MCPConnection], list[str]]:
    """连接配置中的全部 MCP server；单个失败不阻塞其余，失败信息进 warnings。"""
    tools: list[Tool] = []
    conns: list[MCPConnection] = []
    warnings: list[str] = []
    for name, scfg in (servers or {}).items():
        conn = MCPConnection(
            name,
            command=scfg.get("command"),
            args=scfg.get("args") or [],
            env=scfg.get("env"),
            url=scfg.get("url"),
        )
        try:
            await conn.start()
            conns.append(conn)
            tools.extend(await collect_tools(conn))
        except Exception as e:
            warnings.append(f"MCP server '{name}' unavailable: {e}")
            await conn.close()
    return tools, conns, warnings
