"""LiteLLM Provider：100+ 模型统一接入（OpenAI/Anthropic/DeepSeek/GLM/Ollama…）。

litellm 在 chat() 内延迟导入——单测与无 API key 的环境无需安装/配置。
OpenAI 兼容厂商（智谱/月之暗面等，litellm 新版可能不认其前缀）自动改走
`openai/<模型名>` + Base URL 的兼容通道；用户显式填了 Base URL 时一律走兼容通道。
"""

from __future__ import annotations

import json
from typing import Any, Callable

from ..core.messages import Message, ToolUseBlock, Usage
from . import BaseProvider, DeltaCallback, TurnResult

# 这些前缀的厂商都是 OpenAI 兼容协议：litellm 不认时自动降级为 openai/ 通道
OPENAI_COMPATIBLE_PREFIXES = {"zhipuai", "moonshot", "dashscope", "minimax", "custom"}
DEFAULT_BASES = {
    "zhipuai": "https://open.bigmodel.cn/api/paas/v4",
    "moonshot": "https://api.moonshot.cn/v1",
}


class LiteLLMProvider(BaseProvider):
    def __init__(
        self,
        default_model: str,
        temperature: float = 0.2,
        api_key: str | None = None,
        api_base: str | None = None,
        thinking: str | None = None,
    ):
        self.default_model = default_model
        self.temperature = temperature
        self.api_key = api_key
        self.api_base = api_base
        self.thinking = thinking

    async def chat(
        self,
        *,
        system: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        model: str | None = None,
        on_delta: DeltaCallback | None = None,
        on_reason: DeltaCallback | None = None,
    ) -> TurnResult:
        import litellm

        model_str = model or self.default_model
        kwargs: dict[str, Any] = {
            "temperature": self.temperature,
            "num_retries": 2,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        prefix = model_str.split("/", 1)[0].lower()
        rest = model_str.split("/", 1)[1] if "/" in model_str else model_str
        if self.api_base or prefix in OPENAI_COMPATIBLE_PREFIXES:
            # OpenAI 兼容通道（显式 Base URL 或兼容厂商）
            kwargs["model"] = f"openai/{rest}"
            resolved_base = self.api_base or DEFAULT_BASES.get(prefix)
            if resolved_base:
                kwargs["api_base"] = resolved_base
            if self.api_key:
                kwargs["api_key"] = self.api_key
        else:
            kwargs["model"] = model_str
            if self.api_key:
                kwargs["api_key"] = self.api_key
            if self.api_base:
                kwargs["api_base"] = self.api_base
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        if self.thinking and self.thinking != "off":
            # OpenAI 兼容端点（含智谱）：reasoning_effort 直传；max 对不支持的端点收敛为 high
            kwargs["reasoning_effort"] = self.thinking
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if self.api_base:
            kwargs["api_base"] = self.api_base

        response = await litellm.acompletion(
            messages=_openai_messages(system, messages), **kwargs
        )

        content_parts: list[str] = []
        slots: dict[int, dict] = {}
        usage: Usage | None = None
        stop_reason: str | None = None

        async for chunk in response:
            if getattr(chunk, "usage", None):
                usage = Usage(
                    input_tokens=getattr(chunk.usage, "prompt_tokens", 0) or 0,
                    output_tokens=getattr(chunk.usage, "completion_tokens", 0) or 0,
                )
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            rc = getattr(delta, "reasoning_content", None)  # GLM/DeepSeek 系推理增量
            if rc and on_reason:
                on_reason(rc)
            if delta and delta.content:
                content_parts.append(delta.content)
                if on_delta:
                    on_delta(delta.content)
            for tc in getattr(delta, "tool_calls", None) or []:
                slot = slots.setdefault(tc.index, {"id": None, "name": None, "args": []})
                if tc.id:
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    if fn.name:
                        slot["name"] = fn.name
                    if fn.arguments:
                        slot["args"].append(fn.arguments)
            if choice.finish_reason:
                stop_reason = choice.finish_reason

        tool_uses = [_slot_to_use(i, s) for i, s in sorted(slots.items())]
        return TurnResult(
            text="".join(content_parts),
            tool_uses=tool_uses,
            usage=usage,
            stop_reason=stop_reason,
        )


def _openai_messages(system: str, messages: list[Message]) -> list[dict[str, Any]]:
    from ..core.messages import to_openai_messages

    return to_openai_messages(system, messages)


def _slot_to_use(index: int, slot: dict) -> ToolUseBlock:
    raw = "".join(slot["args"])
    try:
        input_data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        input_data = {"_raw_arguments": raw}
    return ToolUseBlock(
        id=slot["id"] or f"call_{index}",
        name=slot["name"] or "",
        input=input_data,
    )
