from fastapi.testclient import TestClient
import shutil

import json
from pathlib import Path

from harness.config import Config
from harness.providers import TurnResult
from harness.server.app import create_app


class FakeProvider:
    async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
        for piece in ("he", "llo"):
            if on_delta:
                on_delta(piece)
        return TurnResult(text="hello")


def _app(tmp_path, mode="bypass", provider_factory=None):
    cfg = Config(data_dir=tmp_path, workspace=tmp_path, permissions_mode=mode)
    return create_app(cfg, provider_factory=provider_factory or (lambda: FakeProvider()))


def test_health(tmp_path):
    client = TestClient(_app(tmp_path))
    h = client.get("/health").json()
    assert h["status"] == "ok"
    # 桌面端握手依赖：version 决定是否替换旧 daemon，workspace 决定切项目是否需要重启
    assert h["version"]
    assert h["workspace"] == str(tmp_path)


def test_ws_e2e_session_and_run(tmp_path):
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        created = ws.receive_json()
        assert created["type"] == "SessionCreated"
        sid = created["session_id"]

        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hi"})
        types = []
        while True:
            event = ws.receive_json()
            types.append(event["type"])
            if event["type"] in ("RunFinished", "Error"):
                break
        assert types[0] == "RunStarted"
        assert "TokenDelta" in types
        assert types[-1] == "RunFinished"

        ws.send_json({"type": "Ping"})
        assert ws.receive_json()["type"] == "Pong"


def test_ws_permission_flow(tmp_path):
    """审批事件往返：模型要写文件 → 服务端发 PermissionRequest → 客户端批准 → 工具执行。"""
    from harness.core.messages import ToolUseBlock

    class ToolProvider:
        def __init__(self):
            self.i = 0

        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            self.i += 1
            if self.i == 1:
                return TurnResult(
                    text="",
                    tool_uses=[ToolUseBlock(id="t1", name="write_file", input={"path": "a.txt", "content": "x"})],
                )
            return TurnResult(text="written")

    client = TestClient(_app(tmp_path, mode="default", provider_factory=lambda: ToolProvider()))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession", "mode": "default"})
        sid = ws.receive_json()["session_id"]

        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "write a.txt"})
        request = None
        while True:
            event = ws.receive_json()
            if event["type"] == "PermissionRequest":
                request = event
                ws.send_json(
                    {"type": "RespondPermission", "request_id": event["request_id"], "answer": "yes"}
                )
            elif event["type"] in ("RunFinished", "Error"):
                final = event
                break
        assert request and request["tool"].startswith("write_file")
        assert final["type"] == "RunFinished" and final["answer"] == "written"
        assert (tmp_path / "a.txt").exists()


def test_ws_model_list_switch_delete(tmp_path):
    """模型配置列表：保存多套 → 仅一个生效 → 切换 → 删除后自动回落。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        ws.receive_json()

        ws.send_json({"type": "SetModel", "model": "a/one", "api_key": "k1"})
        r1 = ws.receive_json()
        assert r1["type"] == "ModelSet" and len(r1["models"]) == 1

        ws.send_json({"type": "SetModel", "model": "b/two", "api_key": "k2"})
        r2 = ws.receive_json()
        flags = {m["model"]: m["active"] for m in r2["models"]}
        assert flags == {"a/one": False, "b/two": True}  # 仅最后保存的生效

        ws.send_json({"type": "SwitchModel", "model": "a/one"})
        s = ws.receive_json()
        assert s["type"] == "Settings" and s["model"] == "a/one"

        ws.send_json({"type": "DeleteModelConfig", "model": "a/one"})
        s = ws.receive_json()
        assert [m["model"] for m in s["models"]] == ["b/two"] and s["model"] == "b/two"  # 自动回落

        ws.send_json({"type": "DeleteModelConfig", "model": "b/two"})
        s = ws.receive_json()
        assert s["models"] == [] and s["has_api_key"] is False  # 全删光回退默认


def test_ws_permission_thinking_duration_attach(tmp_path):
    (tmp_path / "note.txt").write_text("attachment body")
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]

        ws.send_json({"type": "SetPermissionMode", "mode": "plan"})
        assert ws.receive_json()["type"] == "Notice"
        s = ws.receive_json()
        assert s["type"] == "Settings" and s["permission_mode"] == "plan"

        ws.send_json({"type": "SetThinking", "level": "high"})
        assert ws.receive_json()["type"] == "Notice"
        assert ws.receive_json()["thinking"] == "high"

        ws.send_json({"type": "ReadWorkspaceFile", "path": "note.txt"})
        r = ws.receive_json()
        assert r["type"] == "WorkspaceFile" and r["content"] == "attachment body"

        ws.send_json({"type": "ReadWorkspaceFile", "path": "../escape.txt"})
        assert ws.receive_json()["type"] == "Error"

        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hello"})
        while True:
            r = ws.receive_json()
            if r["type"] == "RunFinished":
                assert isinstance(r["duration_ms"], int) and r["duration_ms"] >= 0
                break


def test_ws_content_search_and_export(tmp_path):
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "the quantum flux capacitor"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break

        # 全文搜索：能命中会话正文并带回标题
        ws.send_json({"type": "SearchContent", "query": "quantum"})
        r = ws.receive_json()
        assert r["type"] == "ContentSearchResult" and len(r["results"]) == 1
        assert r["results"][0]["session_id"] == sid
        assert "quantum" in r["results"][0]["snippet"]

        # 导出：文件落盘且包含正文
        ws.send_json({"type": "ExportSession", "session_id": sid})
        r = ws.receive_json()
        assert r["type"] == "Notice" and "已导出" in r["text"]
        r = ws.receive_json()
        assert r["type"] == "SessionExported"
        exported = Path(r["path"]).read_text(encoding="utf-8")
        assert "quantum flux capacitor" in exported


def test_ws_manual_groups(tmp_path):
    """手动分组：建组 → 移入 → 改名（成员跟随）→ 删除组（成员变未分组）。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]

        ws.send_json({"type": "CreateSessionGroup", "name": "工作"})
        r = ws.receive_json()
        assert r["type"] == "SessionList" and r["groups"] == ["工作"]

        ws.send_json({"type": "SetSessionGroup", "session_id": sid, "group": "工作"})
        r = ws.receive_json()
        row = next(s for s in r["sessions"] if s["session_id"] == sid)
        assert row["group"] == "工作"

        ws.send_json({"type": "RenameSessionGroup", "name": "工作", "new_name": "项目A"})
        r = ws.receive_json()
        row = next(s for s in r["sessions"] if s["session_id"] == sid)
        assert row["group"] == "项目A"  # 成员跟随改名

        ws.send_json({"type": "DeleteSessionGroup", "name": "项目A"})
        assert ws.receive_json()["type"] == "Notice"
        r = ws.receive_json()
        assert r["groups"] == []
        row = next(s for s in r["sessions"] if s["session_id"] == sid)
        assert row["group"] is None  # 会话保留但变为未分组


def test_ws_unknown_session(tmp_path):
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "SendMessage", "session_id": "nope", "text": "hi"})
        event = ws.receive_json()
        assert event["type"] == "Error" and "unknown session" in event["error"]


def test_ws_model_settings_and_sessions(tmp_path):
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]

        ws.send_json({"type": "GetSettings"})
        s = ws.receive_json()
        assert s["type"] == "Settings" and s["has_api_key"] is False

        ws.send_json({"type": "SetModel", "model": "deepseek/deepseek-chat", "api_key": "sk-test"})
        r = ws.receive_json()
        assert r["type"] == "ModelSet" and r["model"] == "deepseek/deepseek-chat" and r["has_api_key"]

        ws.send_json({"type": "GetSettings"})
        s = ws.receive_json()
        assert s["model"] == "deepseek/deepseek-chat" and s["has_api_key"] is True

        # 持久化到 settings.json（重启后 provider factory 仍生效）
        saved = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
        assert saved["model"] == "deepseek/deepseek-chat" and saved["api_key"] == "sk-test"

        ws.send_json({"type": "ListSessions"})
        lst = ws.receive_json()
        assert lst["type"] == "SessionList" and any(x["session_id"] == sid for x in lst["sessions"])

        ws.send_json({"type": "ResumeSession", "session_id": sid})
        r = ws.receive_json()
        assert r["type"] == "SessionResumed" and r["session_id"] == sid
        h = ws.receive_json()
        assert h["type"] == "History"  # 回放事件（新会话为空列表）


def test_ws_resume_persists_history(tmp_path):
    """Resume 后消息历史仍在：同一 provider 第二轮能看到第一轮的对话。"""
    from harness.config import Config

    seen_lengths = []

    class P:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            seen_lengths.append(len(messages))
            return TurnResult(text=f"got {len(messages)}")

    cfg = Config(data_dir=tmp_path, workspace=tmp_path, permissions_mode="bypass")
    client = TestClient(create_app(cfg, provider_factory=lambda: P()))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "first"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "second"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break
    # 第二轮消息数 > 第一轮（历史累积）
    assert seen_lengths[1] > seen_lengths[0]


def test_ws_runfinished_usage_and_session_cost(tmp_path):
    """RunFinished 带 usage/cost_usd；GetSessionCost 聚合当前会话用量。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hello"})
        while True:
            r = ws.receive_json()
            if r["type"] == "RunFinished":
                assert set(r["usage"]) == {"input_tokens", "output_tokens"}
                assert r["cost_usd"] is None  # FakeProvider 无真实模型，不猜测价格
                break

        ws.send_json({"type": "GetSessionCost", "session_id": sid})
        c = ws.receive_json()
        assert c["type"] == "SessionCost" and c["session_id"] == sid and c["turns"] == 1


def test_ws_stats(tmp_path):
    """GetStats：本机会话/消息/运行计数与数据目录。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hello"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break

        ws.send_json({"type": "GetStats"})
        s = ws.receive_json()
        assert s["type"] == "Stats"
        assert s["sessions"] >= 1 and s["runs"] == 1 and s["messages"] >= 2
        assert s["data_dir"] == str(tmp_path)


def test_ws_test_model(tmp_path, monkeypatch):
    """TestModel：连通性测试返回 ModelTestResult（不落库、不影响当前配置）。"""
    class PingProvider:
        def __init__(self, model, **_):
            self.default_model = model

        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            return TurnResult(text="pong")

    monkeypatch.setattr(
        "harness.providers.make_provider", lambda backend, model, **k: PingProvider(model, **k)
    )
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "TestModel", "model": "x/y", "api_key": "k"})
        r = ws.receive_json()
        assert r["type"] == "ModelTestResult"
        assert r["ok"] is True and r["model"] == "x/y" and r["reply"] == "pong"
        assert r["latency_ms"] >= 0


def test_ws_test_model_failure(tmp_path, monkeypatch):
    """TestModel：端点失败时 ok=False 并带回错误信息。"""
    def _boom(backend, model, **k):
        raise RuntimeError("connection refused")

    monkeypatch.setattr("harness.providers.make_provider", _boom)
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "TestModel", "model": "x/y"})
        r = ws.receive_json()
        assert r["type"] == "ModelTestResult" and r["ok"] is False
        assert "connection refused" in r["error"]


def test_ws_reasoning_delta(tmp_path):
    """ReasoningDelta：provider 的推理增量经 loop 转发到 WS（正在思考实时展示）。"""
    class ReasonProvider:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            if on_reason:
                on_reason("考虑用 grep 统计")
            if on_delta:
                on_delta("done")
            return TurnResult(text="done")

    client = TestClient(_app(tmp_path, provider_factory=lambda: ReasonProvider()))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hi"})
        types = []
        while True:
            r = ws.receive_json()
            types.append(r["type"])
            if r["type"] in ("RunFinished", "Error"):
                break
        assert "ReasoningDelta" in types
        assert types.index("ReasoningDelta") < types.index("TokenDelta")


def test_ws_reason_absent_when_provider_ignores(tmp_path):
    """不接受 on_reason 的 provider（旧测试桩/自定义实现）照常工作。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hi"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break


def test_ws_cancel_run(tmp_path):
    """停止任务：CancelRun → cancel requested → run cancelled（前端据此复位运行态）。"""
    import asyncio as _aio

    class SlowProvider:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            await _aio.sleep(30)
            return TurnResult(text="never")

    client = TestClient(_app(tmp_path, provider_factory=lambda: SlowProvider()))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "long task"})
        assert ws.receive_json()["type"] == "RunStarted"

        ws.send_json({"type": "CancelRun", "session_id": sid})
        notices = []
        while True:
            r = ws.receive_json()
            if r["type"] == "Notice":
                notices = notices + [r["text"]]
                if "run cancelled" in r["text"]:
                    break
        assert any("cancel requested" in t for t in notices)


def test_ws_fork_session(tmp_path):
    """分支会话：截到第一条用户消息 → 新会话只含前缀、标题 Fork of、自动切入。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "first question"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "second question"})
        while True:
            if ws.receive_json()["type"] == "RunFinished":
                break

        # History 条目带 seq
        ws.send_json({"type": "ResumeSession", "session_id": sid})
        assert ws.receive_json()["type"] == "SessionResumed"
        hist = ws.receive_json()
        assert hist["type"] == "History"
        assert ws.receive_json()["type"] == "ContextInfo"  # 恢复末尾附一条上下文快照
        first_user = next(i for i in hist["items"] if i["kind"] == "user")
        assert isinstance(first_user["seq"], int)

        # 从第一条消息分支
        ws.send_json({"type": "ForkSession", "session_id": sid, "upto_seq": first_user["seq"]})
        r = ws.receive_json()
        assert r["type"] == "Notice" and "分支会话" in r["text"]
        lst = ws.receive_json()
        assert lst["type"] == "SessionList"
        fork_row = next(s for s in lst["sessions"] if s["session_id"] != sid)
        assert fork_row["title"].startswith("Fork of")
        resumed = ws.receive_json()
        assert resumed["type"] == "SessionResumed" and resumed["session_id"] == fork_row["session_id"]
        fh = ws.receive_json()
        assert fh["type"] == "History"
        texts = [i["text"] for i in fh["items"] if i["kind"] == "user"]
        assert texts == ["first question"]

        # 分支会话不复制 run_finished：成本/统计不重复计数
        ws.send_json({"type": "GetSessionCost", "session_id": fork_row["session_id"]})
        c = ws.receive_json()
        while c["type"] == "ContextInfo":  # 恢复会话末尾附带的上下文快照，与成本无关
            c = ws.receive_json()
        assert c["type"] == "SessionCost" and c["turns"] == 0


def _stream_registry():
    """只含一个流式输出工具的注册表：执行期经 ctx.on_output 逐行上报。"""
    from harness.tools.base import Tool, ToolRegistry, ToolSpec

    reg = ToolRegistry()

    async def handler(args, ctx):
        if ctx.on_output:
            ctx.on_output("step 1 done\n")
            ctx.on_output("step 2 done\n")
        return "ok"

    reg.register(
        Tool(ToolSpec(name="slow_tool", description="streams progress", parameters={"type": "object", "properties": {}}), handler)
    )
    return reg


def test_ws_tool_output_streamed(tmp_path):
    """工具执行期过程输出：ctx.on_output → ToolCallOutput 逐行外送，call_id 与卡片关联。"""
    from harness.core.messages import ToolUseBlock

    class ToolProvider:
        def __init__(self):
            self.i = 0

        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            self.i += 1
            if self.i == 1:
                return TurnResult(text="", tool_uses=[ToolUseBlock(id="call_1", name="slow_tool", input={})])
            return TurnResult(text="done")

    cfg = Config(data_dir=tmp_path, workspace=tmp_path, permissions_mode="bypass")
    app = create_app(cfg, provider_factory=lambda: ToolProvider(), registry=_stream_registry())
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "go"})
        started, outputs = None, []
        while True:
            e = ws.receive_json()
            if e["type"] == "ToolCallStarted":
                started = e
            elif e["type"] == "ToolCallOutput":
                outputs.append(e)
            elif e["type"] in ("RunFinished", "Error"):
                break
        assert started and started["call_id"] == "call_1"
        assert [o["text"] for o in outputs] == ["step 1 done\n", "step 2 done\n"]
        assert all(o["call_id"] == "call_1" for o in outputs)


def test_ws_tool_args_streamed(tmp_path):
    """参数流式：provider 支持时参数边生成边推送 ToolCallArgs，且先于 ToolCallStarted。"""
    from harness.core.messages import ToolUseBlock

    class ArgsStreamProvider:
        def __init__(self):
            self.i = 0

        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None, on_tool_stream=None):
            self.i += 1
            if self.i == 1 and on_tool_stream:
                on_tool_stream("call_9", "slow_tool", "")
                on_tool_stream("call_9", "slow_tool", '{"q": 1}')
                return TurnResult(text="", tool_uses=[ToolUseBlock(id="call_9", name="slow_tool", input={"q": 1})])
            return TurnResult(text="done")

    cfg = Config(data_dir=tmp_path, workspace=tmp_path, permissions_mode="bypass")
    app = create_app(cfg, provider_factory=lambda: ArgsStreamProvider(), registry=_stream_registry())
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "go"})
        types = []
        while True:
            e = ws.receive_json()
            types.append(e["type"])
            if e["type"] == "ToolCallStarted":
                assert e["call_id"] == "call_9"
            if e["type"] in ("RunFinished", "Error"):
                break
        assert "ToolCallArgs" in types
        assert types.index("ToolCallArgs") < types.index("ToolCallStarted")


def test_ws_tool_output_absent_for_plain_provider(tmp_path):
    """旧 provider（不认识 on_tool_stream/on_output）：照常完成，不产生新事件。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hi"})
        types = []
        while True:
            e = ws.receive_json()
            types.append(e["type"])
            if e["type"] in ("RunFinished", "Error"):
                break
        assert types[-1] == "RunFinished"
        assert "ToolCallArgs" not in types and "ToolCallOutput" not in types


def test_ws_usage_streamed(tmp_path):
    """Usage 事件：每轮模型返回后推送本 run 累计 token（前端顶栏实时显示会话用量）。"""
    from harness.core.messages import Usage as UsageModel

    class UsageProvider:
        async def chat(self, *, system, messages, tools, model=None, on_delta=None, on_reason=None):
            return TurnResult(text="ok", usage=UsageModel(input_tokens=10, output_tokens=5))

    client = TestClient(_app(tmp_path, provider_factory=lambda: UsageProvider()))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "SendMessage", "session_id": sid, "text": "hi"})
        usages = []
        while True:
            e = ws.receive_json()
            if e["type"] == "Usage":
                usages.append(e)
            elif e["type"] in ("RunFinished", "Error"):
                break
        assert usages and usages[-1]["input_tokens"] == 10 and usages[-1]["output_tokens"] == 5
        assert usages[-1]["session_id"] == sid
        # 上下文容量三件套：当前规模（最后一轮 input tokens）/ 窗口上限 / 静态前缀估算
        assert usages[-1]["context_tokens"] == 10
        assert usages[-1]["context_window"] > 0
        assert usages[-1]["static_tokens"] > 0


def _mkfile(ws, rel, content="x"):
    p = ws / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


def test_ws_file_workbench_crud(tmp_path):
    """工作台文件命令：ListDir/ReadFile/Write/Create/Move/Delete 全链路。"""
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        ws.receive_json()

        def send_wait(cmd):
            ws.send_json(cmd)
            while True:
                r = ws.receive_json()
                if r["type"] in ("Notice", "DirListing", "FileContent", "FileSaved", "SearchResult", "Error", "GitStatus", "GitDiff", "FileBase"):
                    return r

        _mkfile(tmp_path, "src/a.py", "print('hi')\nsecond\n")
        (tmp_path / ".venv").mkdir()
        _mkfile(tmp_path, ".venv/junk.txt", "nope")

        r = send_wait({"type": "ListDir", "path": ""})
        assert r["type"] == "DirListing"
        names = {e["name"]: e["kind"] for e in r["entries"]}
        assert names["src"] == "dir" and ".venv" not in names and "src" in names

        r = send_wait({"type": "ReadFile", "path": "src/a.py"})
        assert r["type"] == "FileContent" and "print" in r["content"] and not r["binary"]

        r = send_wait({"type": "WriteWorkspaceFile", "path": "src/b.txt", "content": "hello"})
        assert r["type"] == "FileSaved" and r["path"] == "src/b.txt"
        assert (tmp_path / "src/b.txt").read_text(encoding="utf-8") == "hello"

        r = send_wait({"type": "CreateEntry", "path": "src/sub", "kind": "dir"})
        assert r["type"] == "Notice" and (tmp_path / "src/sub").is_dir()

        r = send_wait({"type": "MoveEntry", "path": "src/b.txt", "to": "src/sub/b.txt"})
        assert r["type"] == "Notice" and (tmp_path / "src/sub/b.txt").exists()

        r = send_wait({"type": "DeleteEntry", "path": "src/sub/b.txt"})
        assert r["type"] == "Notice" and not (tmp_path / "src/sub/b.txt").exists()
        assert any("trash" in p.name for p in (tmp_path / ".my-harness").iterdir())

        # 越界路径拒绝
        r = send_wait({"type": "ReadFile", "path": "../escape.txt"})
        assert r["type"] == "Error"


def test_ws_read_file_binary_and_truncate(tmp_path):
    _mkfile(tmp_path, "bin.dat", None) if False else (tmp_path / "bin.dat").write_bytes(b"ab\0cd")
    big = tmp_path / "big.txt"
    big.write_text("x" * (1024 * 1024 + 100), encoding="utf-8")
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        ws.receive_json()

        ws.send_json({"type": "ReadFile", "path": "bin.dat"})
        r = ws.receive_json()
        while r["type"] not in ("FileContent", "Error"):
            r = ws.receive_json()
        assert r["type"] == "FileContent" and r["binary"] is True

        ws.send_json({"type": "ReadFile", "path": "big.txt"})
        r = ws.receive_json()
        while r["type"] not in ("FileContent", "Error"):
            r = ws.receive_json()
        assert r["truncated"] is True and len(r["content"]) < 1024 * 1024 + 100


def test_ws_search_workspace(tmp_path):
    _mkfile(tmp_path, "src/a.py", "def foo():\n    return 1\n")
    _mkfile(tmp_path, "docs/b.md", "foo bar\n")
    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        ws.receive_json()
        ws.send_json({"type": "SearchWorkspace", "query": "foo"})
        r = ws.receive_json()
        while r["type"] not in ("SearchResult", "Error"):
            r = ws.receive_json()
        assert r["type"] == "SearchResult"
        paths = {h["path"] for h in r["results"]}
        assert paths == {"src/a.py", "docs/b.md"}
        assert r["results"][0]["line"] >= 1


def test_ws_git_status_diff_base(tmp_path):
    if not shutil.which("git"):
        import pytest
        pytest.skip("git not installed")
    import subprocess
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "t"], check=True)
    _mkfile(tmp_path, "tracked.py", "old\n")
    subprocess.run(["git", "-C", str(tmp_path), "add", "tracked.py"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-qm", "init"], check=True)
    _mkfile(tmp_path, "tracked.py", "new\n")
    _mkfile(tmp_path, "untracked.py", "u\n")

    client = TestClient(_app(tmp_path))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "CreateSession"})
        ws.receive_json()

        ws.send_json({"type": "GitStatus"})
        r = ws.receive_json()
        while r["type"] not in ("GitStatus", "Error"):
            r = ws.receive_json()
        assert r["type"] == "GitStatus" and r["repo"] is True
        codes = {f["path"]: f["code"] for f in r["files"]}
        assert codes.get("tracked.py") == "M" and codes.get("untracked.py") == "??"

        ws.send_json({"type": "GitFileBase", "path": "tracked.py"})
        r = ws.receive_json()
        while r["type"] not in ("FileBase", "Error"):
            r = ws.receive_json()
        assert r["type"] == "FileBase" and r["content"] == "old\n"
