"""LangGraph 循环引擎（可选）：与 ReActLoop 语义一致，用 StateGraph 组织 prepare → agent →(tools)→ prepare。

启用：my-harness.toml `[agent] loop_backend = "langgraph"`（默认 react）。
节点复用同一套权限闸 / shadow 快照 / 压缩 / 记忆注入逻辑，保证两种引擎行为一致。
"""

from __future__ import annotations

import platform
from typing import Callable

from langgraph.graph import END, START, StateGraph

from ..core.events import EventType
from ..core.messages import Message, TextBlock, ToolResultBlock, Usage
from ..providers import BaseProvider, DeltaCallback
from ..tools.base import ToolContext, ToolRegistry
from .react import SYSTEM_TEMPLATE, Budget, NoticeCallback, ToolArgsCallback, ToolOutputCallback, _accepts, _finish


class LangGraphLoop:
    SNAPSHOT_TOOLS = {"write_file", "edit_file"}

    def __init__(
        self,
        provider: BaseProvider,
        registry: ToolRegistry,
        ctx: ToolContext,
        system: str | None = None,
        permissions=None,
        context_engine=None,
        hooks=None,
        shadow=None,
    ):
        self.provider = provider
        self.registry = registry
        self.ctx = ctx
        self.permissions = permissions
        self.context_engine = context_engine
        self.hooks = hooks
        self.shadow = shadow
        self.current_budget: Budget | None = None
        self.system = system or SYSTEM_TEMPLATE.format(
            workspace=ctx.workspace_root, platform=platform.platform()
        )
        # 运行期状态（一个 Loop 实例同一时刻只跑一个 Run；CLI/server 每会话各建一个 Loop）
        self._session = None
        self._state: dict = {}
        self._cbs: dict[str, Callable | None] = {}

        g = StateGraph(dict)
        g.add_node("prepare", self._node_prepare)
        g.add_node("agent", self._node_agent)
        g.add_edge("prepare", "agent")
        g.add_conditional_edges("agent", self._route, {"tools": "prepare", "end": END})
        g.add_edge(START, "prepare")
        self.graph = g.compile()

    # —— 图节点 ——
    async def _node_prepare(self, _state: dict) -> dict:
        s = self._state
        s["tool_executed"] = False
        msgs = self._session.messages()
        if self.context_engine:
            s["last_input"] = s["last_input"] or self.context_engine.estimate(msgs)
            await self.context_engine.maybe_condense(
                self._session, s["last_input"], on_notice=self._cbs.get("on_notice")
            )
        return {}

    async def _node_agent(self, _state: dict) -> dict:
        s = self._state
        s["turns"] += 1
        budget = self.current_budget or Budget()
        session = self._session
        if s["turns"] > budget.max_turns:
            final = f"Stopped: max_turns ({budget.max_turns}) exceeded."
            session.record_assistant_text(final)
            s["final"] = final
            return {}

        # 短期记忆 blocks 注入 system 尾部（静态前缀在前，保 KV-cache）
        from ..memory.blocks import render_blocks_suffix

        system = self.system + render_blocks_suffix(getattr(self.ctx, "blocks", None))

        # on_reason/on_tool_stream 只在调用方需要且 provider 支持时传（兼容 duck-typed 测试桩）
        cb_reason = self._cbs.get("on_reason")
        cb_args = self._cbs.get("on_tool_args")
        chat_kwargs = {}
        if cb_reason is not None and _accepts(self.provider.chat, "on_reason"):
            chat_kwargs["on_reason"] = cb_reason
        if cb_args is not None and _accepts(self.provider.chat, "on_tool_stream"):
            chat_kwargs["on_tool_stream"] = cb_args
        result = await self.provider.chat(
            system=system,
            messages=session.messages(),
            tools=self.registry.specs(),
            on_delta=self._cbs.get("on_delta"),
            **chat_kwargs,
        )
        budget.usage.add(result.usage)
        if self.context_engine:
            s["last_input"] = (
                result.usage.input_tokens
                if result.usage and result.usage.input_tokens
                else self.context_engine.estimate(session.messages())
            )
        cb_usage = self._cbs.get("on_usage")
        if cb_usage:
            cb_usage(budget.usage, s["last_input"])  # 每轮推送：累计用量 + 当前上下文规模
        if result.tool_uses:
            blocks: list = [TextBlock(text=result.text)] if result.text else []
            blocks.extend(result.tool_uses)
            session.record_assistant(Message(role="assistant", blocks=blocks))
            results: list[ToolResultBlock] = []
            for tu in result.tool_uses:
                tr = await self._execute_tool(session, tu)
                results.append(tr)
                if self._cbs.get("on_tool_result"):
                    self._cbs["on_tool_result"](tu, tr)
            session.record_tool_results(results)
            s["tool_executed"] = True
            return {}

        final = result.text
        session.record_assistant(
            Message(role="assistant", blocks=[TextBlock(text=final)] if final else [])
        )
        _finish(session, final, s["turns"], budget.usage, model=getattr(self.provider, "default_model", ""))
        s["final"] = final
        return {}

    def _route(self, _state: dict) -> str:
        return "tools" if self._state.get("tool_executed") else "end"

    # —— 工具执行（与 ReActLoop 相同的管道：hooks → 权限 → 快照 → 执行 → 外置 → post hooks） ——
    async def _execute_tool(self, session, tu) -> ToolResultBlock:
        on_tool = self._cbs.get("on_tool")
        on_tool_result = self._cbs.get("on_tool_result")
        on_notice = self._cbs.get("on_notice")
        if on_tool:
            on_tool(tu)
        if self.hooks:
            hr = await self.hooks.pre_tool(tu.name, tu.input, session.id)
            if hr.blocked:
                if on_notice:
                    on_notice(f"hook blocked {tu.name}: {hr.reason[:120]}")
                return ToolResultBlock(
                    tool_use_id=tu.id,
                    content=f"Blocked by pre_tool_use hook: {hr.reason}",
                    is_error=True,
                )
        if self.permissions:
            allowed, detail = await self.permissions.gate(
                tu.name, tu.input, read_only=self.registry.is_read_only(tu.name)
            )
            session.store.append(
                session.id,
                EventType.PERMISSION_DECISION,
                {"tool": tu.name, "allowed": allowed, "detail": detail},
            )
        else:
            allowed, detail = True, "no gate configured"
        if not allowed:
            return ToolResultBlock(
                tool_use_id=tu.id,
                content=(
                    f"Permission denied by harness policy ({detail}). "
                    "Do not retry the same call; ask the user to adjust permissions "
                    "if this step is required."
                ),
                is_error=True,
            )
        if self.shadow and tu.name in self.SNAPSHOT_TOOLS and tu.input.get("path"):
            self.shadow.snapshot([tu.input["path"]], label=tu.name)
        # 过程输出挂到 ctx 上（bash 逐行上报）；子代理拿的是 ctx 副本，互不干扰
        on_tool_output = self._cbs.get("on_tool_output")
        prev_sink = getattr(self.ctx, "on_output", None)
        if on_tool_output is not None:
            self.ctx.on_output = lambda text, _tu=tu: on_tool_output(_tu, text)
        try:
            tr = await self.registry.execute(tu.name, tu.input, tool_use_id=tu.id, ctx=self.ctx)
        finally:
            self.ctx.on_output = prev_sink
        if self.context_engine and len(tr.content) > self.context_engine.offload_threshold:
            tr.content = self.context_engine.offload_result(session.id, tr.content)
        if self.hooks:
            await self.hooks.post_tool(tu.name, tr.is_error, len(tr.content), session.id)
        return tr

    # —— 入口（签名与 ReActLoop.run 完全一致） ——
    async def run(
        self,
        session,
        task: str,
        budget: Budget | None = None,
        on_delta: DeltaCallback | None = None,
        on_tool=None,
        on_tool_result=None,
        on_notice: NoticeCallback | None = None,
        images: list[dict] | None = None,
        on_reason: DeltaCallback | None = None,
        on_tool_args: ToolArgsCallback | None = None,
        on_tool_output: ToolOutputCallback | None = None,
        on_usage: Callable[[Usage, int], None] | None = None,  # (累计用量, 当前上下文规模)
    ) -> str:
        budget = budget or Budget()
        self.current_budget = budget
        self._session = session
        self._cbs = {
            "on_delta": on_delta,
            "on_tool": on_tool,
            "on_tool_result": on_tool_result,
            "on_notice": on_notice,
            "on_reason": on_reason,
            "on_tool_args": on_tool_args,
            "on_tool_output": on_tool_output,
            "on_usage": on_usage,
        }
        self._state = {"turns": 0, "last_input": 0, "tool_executed": False, "final": None}
        session.store.append(session.id, EventType.RUN_STARTED, {"task": task})
        blocks: list = [TextBlock(text=task)]
        for im in images or []:
            from ..core.messages import ImageBlock

            blocks.append(
                ImageBlock(media_type=im.get("media_type", "image/png"), data=im.get("data", ""))
            )
        session.store.append(
            session.id, EventType.USER_MESSAGE, Message(role="user", blocks=blocks).to_payload()
        )
        await self.graph.ainvoke(self._state, config={"recursion_limit": 200})
        return self._state.get("final") or ""
