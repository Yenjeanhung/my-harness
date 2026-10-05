"""LangChain 模型后端（可选，默认）：ChatOpenAI 覆盖所有 OpenAI 兼容端点（GLM/DeepSeek/中转…）。

与 LiteLLMProvider 实现同一个 BaseProvider 接口，可经 [agent] backend = "langchain"|"litellm" 切换。
anthropic 等非 OpenAI 兼容厂商经 init_chat_model 路由（需对应可选依赖，如 langchain-anthropic）。
"""

from __future__ import annotations

import json
from typing import Any, Callable

from ..core.messages import Message, ToolResultBlock, ToolUseBlock, Usage
from . import BaseProvider, DeltaCallback, TurnResult

# 各厂商的 OpenAI 兼容端点缺省值（用户显式填 Base URL 时覆盖）
DEFAULT_BASES = {
    "openai": None,
    "deepseek": "https://api.deepseek.com",
    "zhipuai": "https://open.bigmodel.cn/api/paas/v4",
    "moonshot": "https://api.moonshot.cn/v1",
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "ollama": "http://localhost:11434/v1",
}


def _patch_lc_reasoning() -> None:
    """langchain-openai 的流式解析只挑官方 OpenAI 字段，GLM/DeepSeek 系在 delta 里给的
    reasoning_content 会被静默丢弃（裸 SSE 实测 coding 端点每条回复几百个推理 delta）。
    包一层转换函数，把该非标字段捞回 additional_kwargs.reasoning_content，chat() 再读出。"""
    try:
        from langchain_openai.chat_models import base as lc_base
    except Exception:  # 未装 langchain-openai 时跳过（litellm 后端不需要）
        return
    if getattr(lc_base, "_myharness_reasoning_patched", False):
        return
    orig = lc_base._convert_delta_to_message_chunk

    def _with_reasoning(_dict, default_class):
        chunk = orig(_dict, default_class)
        try:
            rc = _dict.get("reasoning_content")
        except AttributeError:
            rc = getattr(_dict, "reasoning_content", None)
        if rc and getattr(chunk, "additional_kwargs", None) is not None:
            chunk.additional_kwargs = {**chunk.additional_kwargs, "reasoning_content": rc}
        return chunk

    lc_base._convert_delta_to_message_chunk = _with_reasoning
    lc_base._myharness_reasoning_patched = True


_patch_lc_reasoning()


def to_lc_messages(messages: list[Message]) -> list[Any]:
    import base64

    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    out: list[Any] = []
    for m in messages:
        results = [b for b in m.blocks if isinstance(b, ToolResultBlock)]
        if results:
            out.extend(
                ToolMessage(content=r.content, tool_call_id=r.tool_use_id) for r in results
            )
            continue
        uses = [b for b in m.blocks if isinstance(b, ToolUseBlock)]
        if uses:
            out.append(
                AIMessage(
                    content=m.text() or "",
                    tool_calls=[{"name": t.name, "args": t.input, "id": t.id} for t in uses],
                )
            )
        else:
            imgs = m.images()
            if imgs:
                content: list[Any] = []
                if m.text():
                    content.append({"type": "text", "text": m.text()})
                for b in imgs:
                    content.append(
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{b.media_type};base64,{b.data}"
                            },
                        }
                    )
                out.append(HumanMessage(content=content))
            else:
                out.append(HumanMessage(content=m.text()))
    return out


class LangChainProvider(BaseProvider):
    def __init__(
        self,
        default_model: str,
        temperature: float = 0.2,
        api_key: str | None = None,
        api_base: str | None = None,
        thinking: str | None = None,
        lc_model: Any = None,  # 测试注入：duck-typed LC chat model
    ):
        self.default_model = default_model
        self.temperature = temperature
        self.api_key = api_key
        self.api_base = api_base
        self.thinking = thinking  # off | low | high
        self._lc_model = lc_model

    def _model(self, model: str | None) -> Any:
        if self._lc_model is not None:
            return self._lc_model
        from langchain_openai import ChatOpenAI

        model_str = model or self.default_model
        prefix, _, rest = model_str.partition("/")
        rest = rest or model_str
        base = self.api_base or DEFAULT_BASES.get(prefix.lower())
        kwargs: dict[str, Any] = {
            "model": rest,
            "temperature": self.temperature,
            "stream_usage": True,
        }
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if base:
            kwargs["base_url"] = base
        elif not self.api_key:
            kwargs["api_key"] = "EMPTY"  # 本地端点常见要求；官方端点走环境变量时不会到这里
        # 思考档位：智谱走 thinking 开关 + reasoning_effort 强度（对齐 ZCode 的 低/高/最高）；
        # 其他厂商按 OpenAI reasoning_effort 约定（max 对不支持的端点收敛为 high）
        if prefix.lower() == "zhipuai":
            extra: dict[str, Any] = {}
            if self.thinking == "off":
                extra["thinking"] = {"type": "disabled"}
            else:
                extra["thinking"] = {"type": "enabled"}
                if self.thinking:
                    extra["reasoning_effort"] = self.thinking  # low | high | max
            kwargs["extra_body"] = extra
        elif self.thinking and self.thinking != "off":
            kwargs["reasoning_effort"] = "high" if self.thinking == "max" else self.thinking
        return ChatOpenAI(**kwargs)

    async def chat(
        self,
        *,
        system: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        model: str | None = None,
        on_delta: DeltaCallback | None = None,
        on_reason: DeltaCallback | None = None,
        on_tool_stream=None,
    ) -> TurnResult:
        from langchain_core.messages import SystemMessage

        m = self._model(model)
        if tools:
            m = m.bind_tools(tools)
        lc_msgs = [SystemMessage(content=system), *to_lc_messages(messages)]

        parts: list[str] = []
        slots: dict[int, dict] = {}
        usage: Usage | None = None
        stop_reason: str | None = None

        async for chunk in m.astream(lc_msgs):
            um = getattr(chunk, "usage_metadata", None)
            if um:
                usage = Usage(
                    input_tokens=um.get("input_tokens") or 0,
                    output_tokens=um.get("output_tokens") or 0,
                )
            # 推理增量（GLM/DeepSeek 系把 reasoning_content 放 delta；兼容两种挂载位置）
            ak = getattr(chunk, "additional_kwargs", None) or {}
            reason = ak.get("reasoning_content") or getattr(chunk, "reasoning_content", None)
            if reason and on_reason:
                on_reason(reason)
            c = chunk.content
            if c:
                text = c if isinstance(c, str) else "".join(
                    b.get("text", "") for b in c if isinstance(b, dict)
                )
                if text:
                    parts.append(text)
                    if on_delta:
                        on_delta(text)
            tccs = getattr(chunk, "tool_call_chunks", None) or []
            for t in tccs:
                idx = t.get("index") or 0
                slot = slots.setdefault(idx, {"id": None, "name": None, "args": ""})
                if t.get("id"):
                    slot["id"] = t["id"]
                if t.get("name"):
                    slot["name"] = t["name"]
                    if on_tool_stream:  # 参数开始生成：先报一个空参卡片占位
                        on_tool_stream(slot["id"] or f"call_{idx}", t["name"], "")
                if t.get("args"):
                    slot["args"] += t["args"]
                    if on_tool_stream and slot["name"]:
                        on_tool_stream(slot["id"] or f"call_{idx}", slot["name"], slot["args"])
            if not tccs:
                for i, tc in enumerate(getattr(chunk, "tool_calls", None) or []):
                    # 非流式形状（测试桩/部分供应商）：完整调用直接落位
                    slots.setdefault(i, {"id": tc.get("id"), "name": tc.get("name"), "args": tc.get("args") or {}, "dict": True})

        tool_uses = []
        for i in sorted(slots):
            s = slots[i]
            if isinstance(s["args"], dict):
                input_data = s["args"]
            else:
                raw = s["args"]
                try:
                    input_data = json.loads(raw) if raw.strip() else {}
                except json.JSONDecodeError:
                    input_data = {"_raw_arguments": raw}
            tool_uses.append(ToolUseBlock(id=s["id"] or f"call_{i}", name=s["name"] or "", input=input_data))

        return TurnResult(
            text="".join(parts),
            tool_uses=tool_uses,
            usage=usage,
            stop_reason=stop_reason,
        )
