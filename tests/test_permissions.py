import asyncio

from harness.security.permissions import PermissionEngine, parse_rule


def test_parse_rule():
    r = parse_rule("Bash(git push *)")
    assert r.tool == "Bash" and r.pattern == "git push *"
    assert parse_rule("Edit").pattern is None
    assert parse_rule("mcp__*").tool == "mcp__*"


def test_deny_beats_allow():
    eng = PermissionEngine(mode="default", allow=["Bash(*)"], deny=["Bash(git push *)"])
    ok, _ = asyncio.run(eng.gate("bash", {"command": "git status"}))
    denied, detail = asyncio.run(eng.gate("bash", {"command": "git push origin main"}))
    assert ok and not denied and "git push" in detail


def test_plan_mode_blocks_writes_allows_reads():
    eng = PermissionEngine(mode="plan")
    assert asyncio.run(eng.gate("write_file", {"path": "x"}, read_only=False))[0] is False
    assert asyncio.run(eng.gate("read_file", {"path": "x"}, read_only=True))[0] is True


def test_accept_edits_auto_accepts_file_tools_only():
    calls = []

    async def asker(desc, reason):
        calls.append(desc)
        return "yes"

    eng = PermissionEngine(mode="acceptEdits", asker=asker)
    assert asyncio.run(eng.gate("edit_file", {"path": "a.txt"}))[0] is True
    assert calls == []  # 文件编辑被模式自动接受，未打扰用户
    assert asyncio.run(eng.gate("bash", {"command": "npm install"}))[0] is True
    assert len(calls) == 1  # bash 需要询问


def test_always_extends_session_allow():
    calls = []

    async def asker(desc, reason):
        calls.append(desc)
        return "always"

    eng = PermissionEngine(mode="default", asker=asker)
    assert asyncio.run(eng.gate("bash", {"command": "pytest"}))[0] is True
    assert asyncio.run(eng.gate("bash", {"command": "anything else"}))[0] is True
    assert len(calls) == 1  # 第二次不再询问


def test_dont_ask_denies_without_asking():
    eng = PermissionEngine(mode="dontAsk")
    allowed, detail = asyncio.run(eng.gate("bash", {"command": "ls"}))
    assert not allowed and "dontAsk" in detail


def test_no_channel_denies_safely():
    eng = PermissionEngine(mode="default")
    allowed, detail = asyncio.run(eng.gate("bash", {"command": "ls"}))
    assert not allowed and "no approval channel" in detail


def test_loop_respects_deny(tmp_path):
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
                    tool_uses=[ToolUseBlock(id="t1", name="bash", input={"command": "git push origin main"})],
                )
            return TurnResult(text="ok, cannot push")

    eng = PermissionEngine(mode="default", deny=["Bash(git push *)"])
    loop = ReActLoop(
        provider=P(),
        registry=build_default_registry(),
        ctx=ToolContext(workspace_root=tmp_path, data_dir=tmp_path),
        permissions=eng,
    )
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    answer = asyncio.run(loop.run(sess, "push please"))

    assert answer == "ok, cannot push"
    tool_msg = [m for m in sess.messages() if m.role == "tool"][0]
    assert tool_msg.blocks[0].is_error and "Permission denied" in tool_msg.blocks[0].content
    assert any(e.type.value == "permission_decision" for e in store.list_events(sess.id))
