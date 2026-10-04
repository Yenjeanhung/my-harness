import asyncio
import json
import shutil
import subprocess

import pytest

from harness.core.events import EventStore
from harness.core.messages import ToolUseBlock, Usage
from harness.core.session import Session
from harness.loop.react import Budget, ReActLoop
from harness.orchestrator.subagent import ORCHESTRATOR_GUIDE, build_subagent_tool
from harness.providers import TurnResult
from harness.tools.base import ToolContext
from harness.tools.builtin import build_default_registry


class Scripted:
    """FIFO 脚本化 Provider：调用顺序 = [父#1, 子#1, 子#2, 父#2]。"""

    def __init__(self, turns):
        self.turns = list(turns)
        self.i = 0

    async def chat(self, *, system, messages, tools, model=None, on_delta=None):
        r = self.turns[self.i]
        self.i += 1
        return r


def test_subagent_isolated_context(tmp_path):
    store = EventStore(data_dir=tmp_path)
    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    provider = Scripted(
        [
            TurnResult(text="", tool_uses=[ToolUseBlock(id="p1", name="spawn_subagent", input={"task": "write sub.txt with hi"})]),
            TurnResult(text="", tool_uses=[ToolUseBlock(id="c1", name="write_file", input={"path": "sub.txt", "content": "hi"})]),
            TurnResult(text="child finished: wrote sub.txt"),
            TurnResult(text="orchestrator done"),
        ]
    )
    loop = ReActLoop(provider=provider, registry=build_default_registry(), ctx=ctx)
    loop.registry.register(build_subagent_tool(loop, store))
    sess = Session(store)
    ctx.session_id = sess.id  # 父会话绑定（CLI/server 会做同样的事）
    answer = asyncio.run(loop.run(sess, "delegate", budget=Budget(max_turns=10)))

    assert answer == "orchestrator done"
    assert (tmp_path / "sub.txt").read_text() == "hi"  # 子代理真的执行了
    assert any(e.type.value == "subagent_spawned" for e in store.list_events(sess.id))

    # 父上下文隔离：只看到 spawn 的工具结果（子代理摘要），看不到子代理的 write_file 过程
    parent_text = json.dumps([m.model_dump() for m in sess.messages()], ensure_ascii=False)
    assert "child finished" in parent_text  # 摘要回传
    assert '"name": "write_file"' not in parent_text.replace(" ", "")  # 子代理过程不进父上下文


def test_budget_tree_shares_usage(tmp_path):
    store = EventStore(data_dir=tmp_path)
    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    provider = Scripted(
        [
            TurnResult(text="", tool_uses=[ToolUseBlock(id="p1", name="spawn_subagent", input={"task": "t"})],
                       usage=Usage(input_tokens=10, output_tokens=5)),
            TurnResult(text="", tool_uses=[ToolUseBlock(id="c1", name="glob", input={})],
                       usage=Usage(input_tokens=5, output_tokens=5)),
            TurnResult(text="child done", usage=Usage(input_tokens=5, output_tokens=5)),
            TurnResult(text="parent done", usage=Usage(input_tokens=10, output_tokens=10)),
        ]
    )
    loop = ReActLoop(provider=provider, registry=build_default_registry(), ctx=ctx)
    loop.registry.register(build_subagent_tool(loop, store))
    budget = Budget(max_turns=10)
    asyncio.run(loop.run(Session(store), "go", budget=budget))
    # 父 (10+10, 5+10) + 子 (5+5, 5+5) 共享同一累计器
    assert budget.usage.input_tokens == 30 and budget.usage.output_tokens == 25


def test_worker_registry_cannot_spawn(tmp_path):
    store = EventStore(data_dir=tmp_path)
    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    loop = ReActLoop(provider=Scripted([]), registry=build_default_registry(), ctx=ctx)
    loop.registry.register(build_subagent_tool(loop, store))
    worker = loop.registry.clone_without({"spawn_subagent"})
    assert "spawn_subagent" not in [t["function"]["name"] for t in worker.specs()]


def test_orchestrator_guide_content():
    assert "spawn_subagent" in ORCHESTRATOR_GUIDE and "FRESH" in ORCHESTRATOR_GUIDE


def _docker_ready():
    if not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(["docker", "images", "-q", "alpine"], capture_output=True, timeout=30)
        return bool(r.stdout.strip())
    except Exception:
        return False


@pytest.mark.skipif(not _docker_ready(), reason="docker 或 alpine 镜像不可用")
def test_docker_sandbox_via_registry(tmp_path):
    from harness.security.sandbox import DockerSandbox

    (tmp_path / "hi.txt").write_text("hello sandbox")
    reg = build_default_registry(sandbox=DockerSandbox(image="alpine"))
    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path)
    r = asyncio.run(reg.execute("bash", {"command": "cat hi.txt"}, tool_use_id="t1", ctx=ctx))
    assert not r.is_error and "hello sandbox" in r.content

    r = asyncio.run(
        reg.execute(
            "bash",
            {"command": "wget -q -T 3 -O- http://example.com >/dev/null 2>&1 || echo NETBLOCKED"},
            tool_use_id="t2",
            ctx=ctx,
        )
    )
    assert "NETBLOCKED" in r.content  # 网络默认关闭
