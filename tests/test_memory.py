import asyncio

import pytest

from harness.core.events import EventStore
from harness.core.session import Session
from harness.memory.blocks import BlockStore
from harness.memory.procedural import load_agent_md
from harness.memory.tools import build_memory_tools
from harness.memory.vault import MemoryVault
from harness.tools.base import ToolContext, ToolRegistry


def test_blocks_set_render_limit_persist(tmp_path):
    bs = BlockStore.for_session(tmp_path, "s1")
    bs.set("task", "do x", description="current goal")
    bs.set("todo", "y")
    r = bs.render()
    assert "<memory_blocks>" in r and "do x" in r and 'chars="4/5000"' in r

    with pytest.raises(ValueError):
        bs.set("task", "x" * 5001)  # 超限回拒（学 ACI：立刻失败并给出可执行建议）

    bs2 = BlockStore.for_session(tmp_path, "s1")  # 重启恢复
    assert [b.value for b in bs2.all()] == ["do x", "y"]
    assert bs2.delete("todo") and not bs2.delete("todo")


def test_vault_read_write_search_escape(tmp_path):
    v = MemoryVault(data_dir=tmp_path, workspace_root=tmp_path / "ws")
    v.write("facts.md", "- user likes vim\n- uses pnpm")
    assert "vim" in v.read("facts.md")
    assert "facts.md" in v.list_dir()
    assert "facts.md:2" in v.search("pnpm")
    v.update("facts.md", "pnpm", "npm")
    assert "npm" in v.read("facts.md")
    v.delete("facts.md")
    with pytest.raises(FileNotFoundError):
        v.read("facts.md")
    with pytest.raises(ValueError):
        v.resolve("../escape.md")


def test_memory_tools_via_registry(tmp_path):
    ctx = ToolContext(
        workspace_root=tmp_path,
        data_dir=tmp_path,
        vault=MemoryVault(tmp_path, tmp_path),
        blocks=BlockStore.for_session(tmp_path, "s"),
        event_store=EventStore(data_dir=tmp_path),
    )
    reg = ToolRegistry()
    for t in build_memory_tools(ctx.vault):
        reg.register(t)

    r = asyncio.run(reg.execute("block_set", {"label": "task", "value": "write tests"}, tool_use_id="t1", ctx=ctx))
    assert not r.is_error and "pinned" in r.content
    r = asyncio.run(reg.execute("memory_write", {"path": "notes.md", "content": "- note1"}, tool_use_id="t2", ctx=ctx))
    assert not r.is_error
    r = asyncio.run(reg.execute("memory_search", {"query": "note1"}, tool_use_id="t3", ctx=ctx))
    assert "notes.md:1" in r.content
    r = asyncio.run(
        reg.execute("memory_update", {"path": "notes.md", "old_str": "note1", "new_str": "NOTE1"}, tool_use_id="t4", ctx=ctx)
    )
    assert not r.is_error
    r = asyncio.run(reg.execute("memory_view", {}, tool_use_id="t5", ctx=ctx))
    assert "notes.md" in r.content

    # 情景检索：写入用户消息后能跨会话搜到
    sess = Session(ctx.event_store)
    sess.record_user("remember the foobar protocol")
    r = asyncio.run(reg.execute("search_history", {"query": "foobar"}, tool_use_id="t6", ctx=ctx))
    assert "foobar" in r.content


def test_consolidator_extracts_and_merges(tmp_path):
    from harness.memory.consolidator import MemoryConsolidator
    from harness.providers import TurnResult

    class FakeSummarizer:
        def __init__(self):
            self.calls = 0

        async def chat(self, *, system, messages, tools, model=None, on_delta=None):
            self.calls += 1
            if self.calls == 1:
                return TurnResult(text='["user prefers pnpm over npm", "deploy target is fly.io"]')
            return TurnResult(text="- user prefers pnpm over npm\n- deploys to fly.io")

    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path, vault=MemoryVault(tmp_path, tmp_path))
    cons = MemoryConsolidator(FakeSummarizer(), ctx.vault)
    sess = Session(EventStore(data_dir=tmp_path))
    sess.record_user("we use pnpm and deploy on fly")
    sess.record_assistant_text("noted")
    sess.record_user("also remember npm is slow here")
    sess.record_assistant_text("ok")

    note = asyncio.run(cons.consolidate(sess))
    assert note and "facts.md" in note
    assert "pnpm" in ctx.vault.read("facts.md")

    # 太短的会话跳过
    short = Session(EventStore(data_dir=tmp_path))
    short.record_user("hi")
    short.record_assistant_text("hello")
    assert asyncio.run(cons.consolidate(short)) is None


def test_agent_md_layers(tmp_path):
    (tmp_path / "AGENT.md").write_text("project rule A")
    g = tmp_path / "g"
    g.mkdir()
    (g / "AGENT.md").write_text("global rule G")
    text = load_agent_md(tmp_path, g)
    assert "project rule A" in text and "global rule G" in text and "Global" in text and "Project" in text


def test_loop_injects_blocks_into_system(tmp_path):
    from harness.loop.react import ReActLoop
    from harness.providers import TurnResult
    from harness.tools.builtin import build_default_registry

    captured = {}

    class P:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None):
            captured["system"] = system
            return TurnResult(text="ok")

    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    ctx.blocks = BlockStore.for_session(tmp_path, "s")
    ctx.blocks.set("task", "verify injection")
    loop = ReActLoop(provider=P(), registry=build_default_registry(), ctx=ctx)
    sess = Session(EventStore(data_dir=tmp_path))
    answer = asyncio.run(loop.run(sess, "hi"))
    assert answer == "ok"
    assert "<memory_blocks>" in captured["system"] and "verify injection" in captured["system"]
