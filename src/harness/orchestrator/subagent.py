"""Subagent（DESIGN.md §4.6 原语 1，上下文经济学核心）：全新上下文执行聚焦子任务，只回传最终摘要。

- 子代理拿不到父对话历史——需要的信息必须写进 task 描述（Anthropic：任务描述质量决定成败）；
- 父上下文只增长一段摘要文字；大对象走文件系统传递；
- 预算树：子代理与父共享同一个 Usage 累计器（Budget.usage）；
- 深度 1：子代理的注册表里没有 spawn_subagent，不能再派生。
"""

from __future__ import annotations

from ..core.events import EventType
from ..core.messages import Usage
from ..core.session import Session
from ..loop.react import Budget, ReActLoop
from ..memory.blocks import BlockStore
from ..tools.base import Tool, ToolSpec

SUBAGENT_SYSTEM = """You are a focused subagent inside My-Harness.

You run in a FRESH context window: the orchestrator only sees your final answer, never this conversation.
Complete the given task with your tools, then return a concise but complete final answer that includes:
key findings, file paths you created or modified, and anything the orchestrator must know.
Do not ask questions back; make reasonable assumptions and state them."""

ORCHESTRATOR_GUIDE = """## Subagent usage (orchestrator)
- Spawn focused subagents with spawn_subagent. Effort scaling: simple lookup = do it yourself;
  comparison tasks = 2-4 subagents; complex research = more, with clearly separated subtasks.
- Each subagent starts with a FRESH context: put the goal, expected output format, tool hints and
  task boundaries into the `task` field — it cannot see this conversation.
- Do not spawn subagents for work that needs this conversation's shared context."""

MAX_SUMMARY_CHARS = 4000


def build_subagent_tool(loop: ReActLoop, store, max_turns: int = 20, system_extra: str = "") -> Tool:
    async def handler(args, ctx):
        task = args["task"]
        sub_sess = Session(store)
        if ctx.session_id:
            store.append(
                ctx.session_id,
                EventType.SUBAGENT_SPAWNED,
                {"task": task[:500], "subagent_session": sub_sess.id},
            )
        sub_ctx = ctx.model_copy(
            update={
                "session_id": sub_sess.id,
                "blocks": BlockStore.for_session(ctx.data_dir, sub_sess.id),
            }
        )
        sub_loop = type(loop)(
            provider=loop.provider,
            registry=loop.registry.clone_without({"spawn_subagent"}),
            ctx=sub_ctx,
            system=SUBAGENT_SYSTEM + (f"\n\n{system_extra}" if system_extra else ""),
            permissions=loop.permissions,
            context_engine=loop.context_engine,
            hooks=loop.hooks,
            shadow=loop.shadow,
        )
        parent_budget = loop.current_budget
        sub_budget = Budget(
            max_turns=max_turns,
            usage=parent_budget.usage if parent_budget else Usage(),
        )
        answer = await sub_loop.run(sub_sess, task, budget=sub_budget)
        return (
            answer[:MAX_SUMMARY_CHARS]
            + (f"\n[truncated]" if len(answer) > MAX_SUMMARY_CHARS else "")
            + f"\n[subagent session: {sub_sess.id}]"
        )

    return Tool(
        ToolSpec(
            name="spawn_subagent",
            description=(
                "Spawn a subagent with a FRESH context window to execute one focused subtask and return "
                "its final answer. The subagent cannot see this conversation — put all needed context "
                "(goal, output format, boundaries) into `task`. Use for parallelizable, search-heavy or "
                "context-polluting subtasks; not for work needing this conversation's shared state."
            ),
            parameters={
                "type": "object",
                "properties": {"task": {"type": "string"}},
                "required": ["task"],
            },
            read_only=False,
            timeout_seconds=1800,
        ),
        handler,
    )
