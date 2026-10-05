import asyncio

from harness.tools.base import ToolContext
from harness.tools.builtin import build_default_registry


def ctx_of(tmp_path):
    return ToolContext(workspace_root=tmp_path, data_dir=tmp_path)


def test_write_read_edit_grep(tmp_path):
    reg = build_default_registry()
    ctx = ctx_of(tmp_path)

    r = asyncio.run(
        reg.execute("write_file", {"path": "a/b.txt", "content": "hello world"}, tool_use_id="t1", ctx=ctx)
    )
    assert not r.is_error, r.content

    r = asyncio.run(reg.execute("read_file", {"path": "a/b.txt"}, tool_use_id="t2", ctx=ctx))
    assert "hello world" in r.content

    r = asyncio.run(
        reg.execute("edit_file", {"path": "a/b.txt", "old_str": "world", "new_str": "harness"}, tool_use_id="t3", ctx=ctx)
    )
    assert not r.is_error, r.content

    r = asyncio.run(reg.execute("grep", {"pattern": "harness"}, tool_use_id="t4", ctx=ctx))
    assert not r.is_error and "b.txt:1" in r.content  # 路径分隔符平台相关，只断言文件名与行号


def test_edit_rejects_ambiguous_match(tmp_path):
    reg = build_default_registry()
    ctx = ctx_of(tmp_path)
    asyncio.run(reg.execute("write_file", {"path": "x.txt", "content": "ab ab"}, tool_use_id="t1", ctx=ctx))
    r = asyncio.run(
        reg.execute("edit_file", {"path": "x.txt", "old_str": "ab", "new_str": "cd"}, tool_use_id="t2", ctx=ctx)
    )
    assert r.is_error and "2 times" in r.content


def test_path_escape_rejected(tmp_path):
    reg = build_default_registry()
    r = asyncio.run(
        reg.execute("read_file", {"path": "../outside.txt"}, tool_use_id="t1", ctx=ctx_of(tmp_path))
    )
    assert r.is_error and "escapes workspace" in r.content


def test_unknown_tool(tmp_path):
    reg = build_default_registry()
    r = asyncio.run(reg.execute("nope", {}, tool_use_id="t1", ctx=ctx_of(tmp_path)))
    assert r.is_error and "Unknown tool" in r.content


def test_bash_streams_output_lines(tmp_path):
    """bash 工具逐行读 stdout：完整结果不丢，ctx.on_output 逐行实时上报。"""
    import asyncio
    import sys

    from harness.tools.builtin import _make_bash

    seen: list[str] = []

    async def main():
        ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path, on_output=seen.append)
        cmd = "echo line1; echo line2" if sys.platform != "win32" else "echo line1; echo line2"
        tool = _make_bash()
        result = await tool({"command": cmd}, ctx)
        return result

    result = asyncio.run(main())
    assert "line1" in result and "line2" in result
    assert "exit_code=0" in result
    assert "".join(seen).count("line") == 2  # 每行都实时上报过
