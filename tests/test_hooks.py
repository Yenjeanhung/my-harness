import asyncio
import sys

from harness.extension.hooks import HookManager


def test_exit_code_2_blocks():
    hm = HookManager({"pre_tool_use": ["exit 2"]})
    r = asyncio.run(hm.pre_tool("bash", {"command": "ls"}, "s1"))
    assert r.blocked and "hook" in r.reason


def test_json_decision_blocks():
    code = "import json,sys; print(json.dumps({'decision':'block','reason':'no npm installs'}))"
    hm = HookManager({"pre_tool_use": [f'"{sys.executable}" -c "{code}"']})
    r = asyncio.run(hm.pre_tool("bash", {"command": "npm install"}, "s1"))
    assert r.blocked and "no npm installs" in r.reason


def test_exit_zero_passes():
    hm = HookManager({"pre_tool_use": ["exit 0"]})
    r = asyncio.run(hm.pre_tool("bash", {"command": "ls"}, "s1"))
    assert not r.blocked


def test_unconfigured_event_passes():
    hm = HookManager({})
    r = asyncio.run(hm.pre_tool("bash", {"command": "ls"}, "s1"))
    assert not r.blocked


def test_loop_blocked_by_hook(tmp_path):
    from harness.core.events import EventStore
    from harness.core.messages import ToolUseBlock
    from harness.core.session import Session
    from harness.loop.react import ReActLoop
    from harness.providers import TurnResult
    from harness.tools.base import ToolContext
    from harness.tools.builtin import build_default_registry

    class P:
        def __init__(self):
            self.i = 0

        async def chat(self, **kw):
            self.i += 1
            if self.i == 1:
                return TurnResult(
                    text="",
                    tool_uses=[ToolUseBlock(id="t1", name="write_file", input={"path": "a.txt", "content": "x"})],
                )
            return TurnResult(text="ok, blocked earlier")

    loop = ReActLoop(
        provider=P(),
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
        hooks=HookManager({"pre_tool_use": ["exit 2"]}),
    )
    sess = Session(EventStore(data_dir=tmp_path))
    answer = asyncio.run(loop.run(sess, "write something"))

    assert not (tmp_path / "a.txt").exists()  # 工具真的没有执行
    tool_msg = [m for m in sess.messages() if m.role == "tool"][0]
    assert tool_msg.blocks[0].is_error and "hook" in tool_msg.blocks[0].content
    assert answer == "ok, blocked earlier"
