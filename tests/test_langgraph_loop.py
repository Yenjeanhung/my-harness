import asyncio

from langchain_core.messages import AIMessage

from harness.core.events import EventStore
from harness.core.messages import Message, TextBlock, ToolUseBlock, Usage
from harness.core.session import Session
from harness.loop.langgraph_loop import LangGraphLoop
from harness.loop.react import Budget
from harness.providers import TurnResult
from harness.tools.base import ToolContext
from harness.tools.builtin import build_default_registry


class FakeProvider:
    """FIFO 脚本化 Provider（与 test_loop 相同的桩）。"""

    def __init__(self, turns):
        self.turns = list(turns)
        self.i = 0

    async def chat(self, *, system, messages, tools, model=None, on_delta=None):
        r = self.turns[self.i]
        self.i += 1
        return r


def test_langgraph_tool_roundtrip(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    provider = FakeProvider(
        [
            TurnResult(
                text="",
                tool_uses=[ToolUseBlock(id="t1", name="write_file", input={"path": "hi.txt", "content": "yo"})],
                usage=Usage(input_tokens=1, output_tokens=1),
            ),
            TurnResult(text="done: wrote hi.txt", usage=Usage(input_tokens=2, output_tokens=1)),
        ]
    )
    loop = LangGraphLoop(
        provider=provider,
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
    )
    answer = asyncio.run(loop.run(sess, "write hi.txt", budget=Budget(max_turns=10)))

    assert answer == "done: wrote hi.txt"
    assert (tmp_path / "hi.txt").exists()
    assert [m.role for m in sess.messages()] == ["user", "assistant", "tool", "assistant"]


def test_langgraph_budget(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)

    class Looping:
        async def chat(self, **kw):
            return TurnResult(text="", tool_uses=[ToolUseBlock(id="t", name="glob", input={})])

    loop = LangGraphLoop(
        provider=Looping(),
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
    )
    answer = asyncio.run(loop.run(sess, "loop forever", budget=Budget(max_turns=3)))
    assert "max_turns" in answer


def test_langgraph_injects_blocks(tmp_path):
    from harness.memory.blocks import BlockStore

    captured = {}

    class P:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None):
            captured["system"] = system
            return TurnResult(text="ok")

    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    ctx.blocks = BlockStore.for_session(tmp_path, "s")
    ctx.blocks.set("task", "verify langgraph injection")
    loop = LangGraphLoop(provider=P(), registry=build_default_registry(), ctx=ctx)
    asyncio.run(loop.run(Session(EventStore(data_dir=tmp_path)), "hi"))
    assert "verify langgraph injection" in captured["system"]
