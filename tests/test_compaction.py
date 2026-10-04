import asyncio

from harness.context.compactor import ContextEngine
from harness.core.events import EventStore
from harness.core.messages import Message, ToolResultBlock, ToolUseBlock
from harness.core.session import Session
from harness.providers import TurnResult


def fill(session, rounds=5):
    for i in range(rounds):
        session.record_assistant(
            Message(
                role="assistant",
                blocks=[ToolUseBlock(id=f"t{i}", name="bash", input={"command": f"cmd {i}"})],
            )
        )
        session.record_tool_results(
            [ToolResultBlock(tool_use_id=f"t{i}", content="x" * 2000 + f" round{i}")]
        )
    session.record_user("follow-up question")


def test_clear_keeps_recent(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    fill(sess, 5)
    n_before = len(store.list_events(sess.id))

    engine = ContextEngine(data_dir=tmp_path)
    note = engine.clear_old_tool_results(sess, keep=2)
    assert note and "3" in note
    assert len(store.list_events(sess.id)) == n_before + 1  # 只追加事件，不改历史

    tool_msgs = [m for m in sess.messages() if m.role == "tool"]
    assert "cleared" in tool_msgs[0].blocks[0].content
    assert "cleared" not in tool_msgs[-2].blocks[0].content
    assert tool_msgs[-1].blocks[0].content.endswith("round4")  # 最近一轮原文保留


def test_clear_view_rebuild_deterministic(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    fill(sess, 3)
    engine = ContextEngine(data_dir=tmp_path)
    engine.clear_old_tool_results(sess, keep=1)

    def view():
        return [b.content for m in sess.messages() if m.role == "tool" for b in m.blocks]

    assert view() == view()  # 多次重建视图结果一致（确定性重放）


def test_summarize(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    fill(sess, 6)

    class FakeSummarizer:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None):
            return TurnResult(text="## Session intent\ndo rounds")

    engine = ContextEngine(summarizer=FakeSummarizer(), data_dir=tmp_path)
    note = asyncio.run(engine.summarize(sess, keep_recent=2))
    assert note and "compacted" in note

    msgs = sess.messages()
    assert any("[conversation summary" in m.text() for m in msgs)
    assert list((tmp_path / "artifacts").rglob("compaction_*.txt"))  # 全量转写落盘
    # 原始事件一个不少（事件溯源：压缩不删历史）
    assert len([e for e in store.list_events(sess.id) if e.type.value == "assistant_message"]) == 6


def test_summarize_skips_when_view_too_small(tmp_path):
    sess = Session(EventStore(data_dir=tmp_path))
    fill(sess, 2)

    class FakeSummarizer:
        async def chat(self, **kw):
            raise AssertionError("should not be called")

    engine = ContextEngine(summarizer=FakeSummarizer(), data_dir=tmp_path)
    assert asyncio.run(engine.summarize(sess, keep_recent=6)) is None


def test_offload(tmp_path):
    engine = ContextEngine(data_dir=tmp_path, offload_threshold=100)
    big = "line\n" * 100
    out = engine.offload_result("sess1", big)
    assert "offloaded" in out and len(out) < len(big)
    assert list((tmp_path / "artifacts" / "sess1").glob("tool_result_*.txt"))
    assert engine.offload_result("sess1", "tiny") == "tiny"  # 小结果原样返回


def test_maybe_condense_thresholds(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    fill(sess, 5)

    engine = ContextEngine(data_dir=tmp_path, clear_trigger=1000)
    note = asyncio.run(engine.maybe_condense(sess, last_input_tokens=2000))
    assert note and "cleared" in note

    engine2 = ContextEngine(data_dir=tmp_path)  # 无 summarizer：85% 触发时安全跳过
    assert asyncio.run(engine2.maybe_condense(sess, last_input_tokens=999_999)) is None
