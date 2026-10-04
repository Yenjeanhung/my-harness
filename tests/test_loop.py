import asyncio

from harness.core.events import EventStore
from harness.core.messages import ToolUseBlock, Usage
from harness.core.session import Session
from harness.loop.react import Budget, ReActLoop, ToolContext  # noqa: F401 (Budget re-export)
from harness.providers import TurnResult
from harness.tools.builtin import build_default_registry


class FakeProvider:
    """脚本化 Provider：按顺序返回预设轮次，不需要 litellm。"""

    def __init__(self, turns):
        self.turns = turns
        self.i = 0

    async def chat(self, *, system, messages, tools, model=None, on_delta=None):
        r = self.turns[self.i]
        self.i += 1
        return r


def test_react_tool_roundtrip(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    provider = FakeProvider(
        [
            TurnResult(
                text="",
                tool_uses=[
                    ToolUseBlock(id="t1", name="write_file", input={"path": "hi.txt", "content": "yo"})
                ],
                usage=Usage(input_tokens=1, output_tokens=1),
            ),
            TurnResult(text="done: wrote hi.txt", usage=Usage(input_tokens=2, output_tokens=1)),
        ]
    )
    loop = ReActLoop(
        provider=provider,
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
    )
    answer = asyncio.run(loop.run(sess, "write hi.txt"))

    assert answer == "done: wrote hi.txt"
    assert (tmp_path / "hi.txt").exists()
    assert [m.role for m in sess.messages()] == ["user", "assistant", "tool", "assistant"]


def test_max_turns_budget(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)

    class Looping:
        async def chat(self, **kw):
            return TurnResult(
                text="",
                tool_uses=[ToolUseBlock(id="t", name="glob", input={})],
            )

    loop = ReActLoop(
        provider=Looping(),
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
    )
    answer = asyncio.run(loop.run(sess, "loop forever", budget=Budget(max_turns=3)))
    assert "max_turns" in answer
