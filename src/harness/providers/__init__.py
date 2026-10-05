"""Provider 抽象：统一返回 TurnResult，流式文本通过 on_delta 回调外送。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable

from pydantic import BaseModel, Field

from ..core.messages import Message, ToolUseBlock, Usage

DeltaCallback = Callable[[str], None]
# 工具调用参数流式回调：(call_id, tool_name, 截至当前的原始参数 JSON 文本)——参数边生成边推送，UI 同步画出工具卡片
ToolStreamCallback = Callable[[str, str, str], None]


class TurnResult(BaseModel):
    text: str = ""
    tool_uses: list[ToolUseBlock] = Field(default_factory=list)
    usage: Usage | None = None
    stop_reason: str | None = None


class BaseProvider(ABC):
    @abstractmethod
    async def chat(
        self,
        *,
        system: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        model: str | None = None,
        on_delta: DeltaCallback | None = None,
        on_reason: DeltaCallback | None = None,  # 推理内容（reasoning_content）增量，用于「正在思考」实时展示
        on_tool_stream: ToolStreamCallback | None = None,  # 工具调用参数增量，用于工具卡片实时预览
    ) -> TurnResult: ...


BACKENDS = ("langchain", "litellm")


def make_provider(
    backend: str,
    model: str,
    api_key: str | None = None,
    api_base: str | None = None,
    thinking: str | None = None,
) -> BaseProvider:
    """按 backend 构造模型后端（langchain=默认 / litellm）。thinking: off|low|high。"""
    if backend == "langchain":
        from .langchain_provider import LangChainProvider

        return LangChainProvider(model, api_key=api_key, api_base=api_base, thinking=thinking)
    from .litellm_provider import LiteLLMProvider

    return LiteLLMProvider(model, api_key=api_key, api_base=api_base, thinking=thinking)
