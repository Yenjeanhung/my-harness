import pytest

from harness.core.events import EventStore, EventType
from harness.core.session import Session


def test_event_roundtrip_and_view_rebuild(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s = Session(store)
    s.record_user("hello")
    s.record_assistant_text("hi there")

    # 新的 Session 对象（模拟进程重启后 resume）
    msgs = Session(store, s.id).messages()
    assert [m.role for m in msgs] == ["user", "assistant"]
    assert msgs[0].text() == "hello"
    assert msgs[1].text() == "hi there"


def test_seq_monotonic(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s = Session(store)
    e1 = s.record_user("a")
    e2 = s.record_user("b")
    assert e2.seq == e1.seq + 1
    assert len(store.list_events(s.id)) == 2


def test_list_sessions_title(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s = Session(store)
    s.record_user("帮我写个爬虫")
    rows = store.list_sessions()
    assert rows[0]["title"].startswith("帮我写个爬虫")


def test_searchable_text_precomputed(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s = Session(store)
    s.record_user("帮我设计一个 harness 项目")
    s.record_assistant_text("好的，先写设计文档")

    # 命中正文，返回上下文 snippet
    rows = store.search("harness")
    assert rows and rows[0]["session_id"] == s.id
    assert "harness" in rows[0]["snippet"]

    # JSON 键名不再假阳性（旧实现对 payload JSON 直接 LIKE 会命中）
    assert store.search("blocks") == []
    assert store.search("payload") == []

    # ASCII 大小写不敏感 + LIKE 通配符按字面量处理
    assert store.search("HARNESS")[0]["session_id"] == s.id
    s.record_user("100% 完成了吗")
    assert store.search("100% 完成")[0]["session_id"] == s.id

    # rename/pin 等 meta 更新不丢 searchable_text
    store.set_session_meta(s.id, pinned=True, title="设计会话")
    assert store.search("harness")[0]["session_id"] == s.id

    # 搜索按最近活跃排序
    s2 = Session(store)
    s2.record_user("另一个 harness 讨论")
    assert store.search("harness")[0]["session_id"] == s2.id

    # 老库回填：清掉 meta 行后新实例能从事件流重建
    store._db.execute("DELETE FROM session_meta")
    store._db.commit()
    store2 = EventStore(data_dir=tmp_path)
    rows = store2.search("harness")
    assert {r["session_id"] for r in rows} == {s.id, s2.id}


def test_session_meta_rename_pin_and_delete(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s1, s2 = Session(store), Session(store)
    s1.record_user("first")
    s2.record_user("second")

    # 重命名 + 置顶
    store.set_session_meta(s1.id, title="自定义标题")
    store.set_session_meta(s1.id, pinned=True)
    rows = store.list_sessions()
    assert rows[0]["session_id"] == s1.id and rows[0]["pinned"] is True  # 置顶优先
    assert rows[0]["title"] == "自定义标题"
    # 未命名的会话回退到首条消息标题
    assert rows[1]["title"].startswith("second")

    # 删除：事件 + 元数据 + JSONL 全清
    store.delete_session(s1.id)
    assert store.list_sessions()[0]["session_id"] == s2.id
    assert store.list_events(s1.id) == []
    assert not (store.sessions_dir / f"{s1.id}.jsonl").exists()


def test_list_sessions(tmp_path):
    store = EventStore(data_dir=tmp_path)
    s1, s2 = Session(store), Session(store)
    s1.record_user("x")
    s2.record_user("y")
    ids = {r["session_id"] for r in store.list_sessions()}
    assert {s1.id, s2.id} <= ids


def test_stats_counts(tmp_path):
    """本机统计：会话/消息/运行计数与 token 用量（设置页「常规」数据源）。"""
    store = EventStore(data_dir=tmp_path)
    s = Session(store)
    s.record_user("hello")
    s.record_assistant_text("hi there")
    store.append(
        s.id, EventType.RUN_FINISHED, {"usage": {"input_tokens": 10, "output_tokens": 5}}
    )
    st = store.stats()
    assert st["sessions"] == 1
    assert st["messages"] == 2
    assert st["runs"] == 1
    assert st["input_tokens"] == 10 and st["output_tokens"] == 5
    assert st["db_bytes"] > 0
