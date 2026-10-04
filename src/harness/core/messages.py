"""规范化消息模型：与 Provider 无关的 content blocks（DESIGN.md §3.3）。"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field


class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageBlock(BaseModel):
    type: Literal["image"] = "image"
    media_type: str = "image/png"  # image/png | image/jpeg | image/gif | image/webp
    data: str  # base64


class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any] = Field(default_factory=dict)


class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, other: "Usage | None") -> None:
        if other is None:
            return
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens


class Message(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    blocks: list[Block] = Field(default_factory=list)

    def text(self) -> str:
        return "".join(b.text for b in self.blocks if isinstance(b, TextBlock))

    def images(self) -> list[ImageBlock]:
        return [b for b in self.blocks if isinstance(b, ImageBlock)]

    def to_payload(self) -> dict[str, Any]:
        return {"role": self.role, "blocks": [b.model_dump() for b in self.blocks]}

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Message":
        builders = {
            "text": TextBlock,
            "image": ImageBlock,
            "tool_use": ToolUseBlock,
            "tool_result": ToolResultBlock,
        }
        blocks = [builders[d["type"]](**d) for d in payload.get("blocks", [])]
        return cls(role=payload["role"], blocks=blocks)


def to_openai_messages(system: str | None, messages: list[Message]) -> list[dict[str, Any]]:
    """转换为 OpenAI/LiteLLM 消息格式。tool 消息按 tool_use_id 展开为多条；图片进多模态 content。"""
    out: list[dict[str, Any]] = []
    if system:
        out.append({"role": "system", "content": system})
    for m in messages:
        results = [b for b in m.blocks if isinstance(b, ToolResultBlock)]
        if results:
            for r in results:
                out.append({"role": "tool", "tool_call_id": r.tool_use_id, "content": r.content})
            continue
        uses = [b for b in m.blocks if isinstance(b, ToolUseBlock)]
        text = m.text()
        images = m.images()
        if uses:
            out.append(
                {
                    "role": "assistant",
                    "content": text or None,
                    "tool_calls": [
                        {
                            "id": t.id,
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "arguments": json.dumps(t.input, ensure_ascii=False),
                            },
                        }
                        for t in uses
                    ],
                }
            )
        elif images:
            content: list[dict[str, Any]] = []
            if text:
                content.append({"type": "text", "text": text})
            content += [
                {"type": "image_url", "image_url": {"url": f"data:{b.media_type};base64,{b.data}"}}
                for b in images
            ]
            out.append({"role": m.role, "content": content})
        else:
            out.append({"role": m.role, "content": text})
    return out
