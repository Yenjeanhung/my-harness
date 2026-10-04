import asyncio
import sys
from types import SimpleNamespace

from harness.tools.base import ToolContext, ToolRegistry
from harness.tools.mcp_client import MCPConnection, collect_tools


class FakeSession:
    """鸭子类型 MCP 会话桩：不需要真实子进程。"""

    def __init__(self):
        self.calls = []
        self.tools = SimpleNamespace(
            tools=[
                SimpleNamespace(
                    name="echo",
                    description="Echo text",
                    inputSchema={
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"],
                    },
                    annotations=SimpleNamespace(readOnlyHint=True),
                ),
                SimpleNamespace(
                    name="boom",
                    description="Always fails",
                    inputSchema={"type": "object", "properties": {}},
                    annotations=None,
                ),
            ]
        )

    async def list_tools(self):
        return self.tools

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        if name == "boom":
            return SimpleNamespace(content=[SimpleNamespace(text="boom happened")], isError=True)
        return SimpleNamespace(content=[SimpleNamespace(text=f"echo: {args.get('text')}")], isError=False)


def _connection() -> MCPConnection:
    conn = MCPConnection("test", "noop")
    conn.session = FakeSession()  # 跳过真实进程，直接注入会话桩
    return conn


def test_collect_tools_namespaces_and_annotations(tmp_path):
    tools = asyncio.run(collect_tools(_connection()))
    assert [t.spec.name for t in tools] == ["mcp__test__echo", "mcp__test__boom"]
    assert tools[0].spec.read_only is True  # readOnlyHint 注解映射
    assert tools[1].spec.read_only is False


def test_mcp_tools_run_via_registry(tmp_path):
    reg = ToolRegistry()
    for t in asyncio.run(collect_tools(_connection())):
        reg.register(t)
    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)

    r = asyncio.run(reg.execute("mcp__test__echo", {"text": "hi"}, tool_use_id="t1", ctx=ctx))
    assert not r.is_error and r.content == "echo: hi"

    r = asyncio.run(reg.execute("mcp__test__boom", {}, tool_use_id="t2", ctx=ctx))
    assert r.is_error and "boom happened" in r.content  # isError=True → 错误回填给模型


def test_connect_all_http_unreachable_warns():
    """url 型配置（streamable http）：连不上时只告警不崩溃。"""
    from harness.tools.mcp_client import connect_all

    tools, conns, warnings = asyncio.run(connect_all({"bad": {"url": "http://127.0.0.1:1/mcp"}}))
    assert tools == [] and conns == []
    assert len(warnings) == 1 and "bad" in warnings[0]


DEMO_SERVER = '''
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("demo")

@mcp.tool()
def echo(text: str) -> str:
    """Echo the given text back."""
    return "echo: " + text

if __name__ == "__main__":
    mcp.run()
'''


def test_real_stdio_roundtrip(tmp_path):
    """真实 stdio 子进程端到端：拉起 FastMCP server → list_tools → call_tool → 关闭。"""

    async def go():
        conn = MCPConnection("demo", sys.executable, ["-c", DEMO_SERVER])
        await conn.start()
        try:
            tools = await collect_tools(conn)
            assert any(t.spec.name == "mcp__demo__echo" for t in tools)
            reg = ToolRegistry()
            for t in tools:
                reg.register(t)
            ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
            r = await reg.execute("mcp__demo__echo", {"text": "hi"}, tool_use_id="t1", ctx=ctx)
            assert not r.is_error, r.content
            assert r.content == "echo: hi"
        finally:
            await conn.close()

    asyncio.run(go())
