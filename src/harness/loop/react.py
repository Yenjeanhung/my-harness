"""ReAct 主循环（DESIGN.md §4.2/§4.3/§4.5）。

每轮：条件压缩 → 组视图 → 模型 → 工具逐个过权限闸 → 执行（大结果外置）→ 回填 → 循环。
三条铁律：每个 tool_use 必有对应 tool_result；清理只动结果不动动作史；错误保留在上下文中。
"""

from __future__ import annotations

import inspect
import platform
from dataclasses import dataclass, field
from typing import Callable

from ..core.events import EventType
from ..core.messages import Message, TextBlock, ToolResultBlock, ToolUseBlock, Usage
from ..providers import BaseProvider, DeltaCallback
from ..tools.base import ToolContext, ToolRegistry

SYSTEM_TEMPLATE = """You are a capable coding agent running inside My-Harness.

Environment:
- Workspace root: {workspace}
- Platform: {platform}

Rules:
- Use the provided tools to read, search and modify files. Prefer targeted reads (offset/limit, grep) over dumping whole files.
- After each tool call, check the result before deciding the next step.
- Commands have a 120s timeout and are killed afterwards. For expensive operations (large scans, bulk deletes, builds, installs), work in batches and write scripts that PRINT PROGRESS as they go (e.g. one line per directory) instead of a single summary at the end — silent commands look hung and get killed mid-work.
- Keep final answers concise; report faithfully what you did, including errors and incomplete work.
- Never invent tool output. If a tool fails, adjust and retry differently or tell the user.
"""


@dataclass
class Budget:
    max_turns: int = 40
    usage: Usage = field(default_factory=Usage)  # 整棵代理树共享累计（父+全部子代理）


NoticeCallback = Callable[[str], None]
# 工具调用参数流式生成回调：(call_id, tool_name, 累积的原始参数文本)
ToolArgsCallback = Callable[[str, str, str], None]
# 工具执行期过程输出回调：(tool_use, 输出增量)
ToolOutputCallback = Callable[[ToolUseBlock, str], None]


def _accepts(func: Callable, name: str) -> bool:
    """provider.chat 是否接受某关键字参数（兼容不接受新回调的旧实现/测试桩）。"""
    try:
        return name in inspect.signature(func).parameters
    except (TypeError, ValueError):
        return False


class ReActLoop:
    # 修改类工具：执行前自动打 shadow 快照（DESIGN.md §4.7）
    SNAPSHOT_TOOLS = {"write_file", "edit_file"}

    def __init__(
        self,
        provider: BaseProvider,
        registry: ToolRegistry,
        ctx: ToolContext,
        system: str | None = None,
        permissions=None,        # PermissionEngine | None：None = 不设闸（仅测试/内嵌场景）
        context_engine=None,     # ContextEngine | None：None = 不做压缩
        hooks=None,              # HookManager | None：None = 无生命周期钩子
        shadow=None,             # ShadowCheckpoint | None：None = 不做快照
    ):
        self.provider = provider
        self.registry = registry
        self.ctx = ctx
        self.permissions = permissions
        self.context_engine = context_engine
        self.hooks = hooks
        self.shadow = shadow
        self.current_budget: Budget | None = None  # run() 期间指向当前预算（子代理读它共享用量）
        self.system = system or SYSTEM_TEMPLATE.format(
            workspace=ctx.workspace_root, platform=platform.platform()
        )

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
        on_usage: Callable[[Usage, int], None] | None = None,  # (累计用量, 当前上下文规模=最后一轮 input tokens)
    ) -> str:
        budget = budget or Budget()
        self.current_budget = budget
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
        usage_total = budget.usage  # 共享累计器：子代理写入同一对象
        turns = 0
        last_input = 0

        while True:
            turns += 1
            if turns > budget.max_turns:
                final = f"Stopped: max_turns ({budget.max_turns}) exceeded."
                session.record_assistant_text(final)
                _finish(session, final, turns, usage_total, model=getattr(self.provider, "default_model", ""))
                return final

            msgs = session.messages()
            if self.context_engine:
                last_input = last_input or self.context_engine.estimate(msgs)
                await self.context_engine.maybe_condense(session, last_input, on_notice=on_notice)
                msgs = session.messages()  # 压缩后重建视图

            # 短期记忆 blocks 动态注入到 system 尾部（静态前缀在前，保 KV-cache）
            system = self.system
            blocks = getattr(self.ctx, "blocks", None)
            if blocks is not None:
                from ..memory.blocks import render_blocks_suffix

                system += render_blocks_suffix(blocks)

            # on_reason/on_tool_stream 只在调用方需要且 provider 支持时传（兼容 duck-typed 测试桩）
            chat_kwargs = {}
            if on_reason is not None and _accepts(self.provider.chat, "on_reason"):
                chat_kwargs["on_reason"] = on_reason
            if on_tool_args is not None and _accepts(self.provider.chat, "on_tool_stream"):
                chat_kwargs["on_tool_stream"] = on_tool_args
            result = await self.provider.chat(
                system=system,
                messages=msgs,
                tools=self.registry.specs(),
                on_delta=on_delta,
                **chat_kwargs,
            )
            usage_total.add(result.usage)
            if self.context_engine:
                last_input = (
                    result.usage.input_tokens
                    if result.usage and result.usage.input_tokens
                    else self.context_engine.estimate(msgs)
                )
            if on_usage:
                on_usage(usage_total, last_input)  # 每轮推送：累计用量 + 当前上下文规模（UI 实时显示）

            if result.tool_uses:
                blocks: list = [TextBlock(text=result.text)] if result.text else []
                blocks.extend(result.tool_uses)
                session.record_assistant(Message(role="assistant", blocks=blocks))
                results: list[ToolResultBlock] = []
                for tu in result.tool_uses:
                    if on_tool:
                        on_tool(tu)
                    # ① PreToolUse hooks（软扩展，可阻断）
                    if self.hooks:
                        hr = await self.hooks.pre_tool(tu.name, tu.input, session.id)
                        if hr.blocked:
                            tr = ToolResultBlock(
                                tool_use_id=tu.id,
                                content=f"Blocked by pre_tool_use hook: {hr.reason}",
                                is_error=True,
                            )
                            if on_tool_result:
                                on_tool_result(tu, tr)
                            if on_notice:
                                on_notice(f"hook blocked {tu.name}: {hr.reason[:120]}")
                            results.append(tr)
                            continue
                    # ② 权限闸（硬规则）
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
                        tr = ToolResultBlock(
                            tool_use_id=tu.id,
                            content=(
                                f"Permission denied by harness policy ({detail}). "
                                "Do not retry the same call; ask the user to adjust permissions "
                                "if this step is required."
                            ),
                            is_error=True,
                        )
                    else:
                        # ③ 修改类工具执行前打 shadow 快照（可 /rollback）
                        if self.shadow and tu.name in self.SNAPSHOT_TOOLS:
                            path_arg = tu.input.get("path")
                            if path_arg:
                                self.shadow.snapshot([path_arg], label=tu.name)
                        # 过程输出挂到 ctx 上（bash 逐行上报）；子代理拿的是 ctx 副本，互不干扰
                        prev_sink = getattr(self.ctx, "on_output", None)
                        if on_tool_output is not None:
                            self.ctx.on_output = lambda text, _tu=tu: on_tool_output(_tu, text)
                        try:
                            tr = await self.registry.execute(
                                tu.name, tu.input, tool_use_id=tu.id, ctx=self.ctx
                            )
                        finally:
                            self.ctx.on_output = prev_sink
                        if self.context_engine and len(tr.content) > self.context_engine.offload_threshold:
                            tr.content = self.context_engine.offload_result(session.id, tr.content)
                    results.append(tr)
                    if on_tool_result:
                        on_tool_result(tu, tr)
                    # ④ PostToolUse hooks（仅通知，不阻断）
                    if self.hooks:
                        await self.hooks.post_tool(tu.name, tr.is_error, len(tr.content), session.id)
                session.record_tool_results(results)
                continue

            final = result.text
            session.record_assistant(
                Message(role="assistant", blocks=[TextBlock(text=final)] if final else [])
            )
            _finish(session, final, turns, usage_total, model=getattr(self.provider, "default_model", ""))
            return final


def _finish(session, final: str, turns: int, usage: Usage, model: str = "") -> None:
    session.store.append(
        session.id,
        EventType.RUN_FINISHED,
        {"answer": final[:2000], "turns": turns, "usage": usage.model_dump(), "model": model},
    )
