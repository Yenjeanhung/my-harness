"""Session：一条事件流 + 从事件重建消息视图（View）。

压缩不是删除：COMPACTION 事件只记录「如何变换视图」，原始事件永远保留、确定性重放（DESIGN.md §4.5/§4.7）。
"""

from __future__ import annotations

import uuid
from typing import Any

from .events import EventStore, EventType
from .messages import Message, TextBlock, ToolResultBlock

_MESSAGE_EVENTS = {
    EventType.USER_MESSAGE,
    EventType.ASSISTANT_MESSAGE,
    EventType.TOOL_RESULTS,
}


class Session:
    def __init__(self, store: EventStore, session_id: str | None = None):
        self.store = store
        self.id = session_id or uuid.uuid4().hex

    # —— 写入 ——
    def record_user(self, text: str):
        return self.store.append(
            self.id, EventType.USER_MESSAGE,
            Message(role="user", blocks=[TextBlock(text=text)]).to_payload(),
        )

    def record_assistant(self, message: Message):
        return self.store.append(self.id, EventType.ASSISTANT_MESSAGE, message.to_payload())

    def record_assistant_text(self, text: str):
        return self.record_assistant(
            Message(role="assistant", blocks=[TextBlock(text=text)])
        )

    def record_tool_results(self, results: list[ToolResultBlock]):
        msg = Message(role="tool", blocks=list(results))
        return self.store.append(self.id, EventType.TOOL_RESULTS, msg.to_payload())

    # —— 读取：事件 → 视图 ——
    def messages_with_seq(self) -> list[list]:
        """返回 [seq, Message] 条目；按序应用 COMPACTION 事件对视图的变换。"""
        entries: list[list] = []
        for e in self.store.list_events(self.id):
            if e.type in _MESSAGE_EVENTS:
                entries.append([e.seq, Message.from_payload(e.payload)])
            elif e.type == EventType.COMPACTION:
                self._apply_compaction(entries, e.payload)
        return entries

    def messages(self) -> list[Message]:
        return [m for _, m in self.messages_with_seq()]

    @staticmethod
    def _apply_compaction(entries: list[list], payload: dict[str, Any]) -> None:
        kind = payload.get("kind")
        if kind == "clear_tool_results":
            by_seq = {e[0]: e for e in entries}
            for c in payload.get("cleared", []):
                entry = by_seq.get(c["seq"])
                if entry is None or c["block_index"] >= len(entry[1].blocks):
                    continue
                entry[1].blocks[c["block_index"]] = ToolResultBlock(
                    tool_use_id=c["tool_use_id"],
                    content=(
                        f"[cleared: earlier output was {c['chars']} chars. "
                        "Re-run the tool if you need this content.]"
                    ),
                )
        elif kind == "summarize":
            s1, s2 = payload.get("covered_seq", [0, 0])
            in_range = [e for e in entries if s1 <= e[0] <= s2]
            if not in_range:
                return
            text = (
                "[conversation summary — earlier history was compacted; "
                f"full transcript: {payload.get('transcript_path', '')}]\n\n"
                f"{payload.get('summary', '')}"
            )
            recent = payload.get("recent_files") or []
            if recent:
                text += "\n\nRecently touched files (re-read as needed):\n" + "\n".join(
                    f"- {f}" for f in recent
                )
            replaced = False
            out: list[list] = []
            for e in entries:
                if s1 <= e[0] <= s2:
                    if not replaced:  # 范围内第一条替换为摘要消息，其余从视图移除（事件仍在）
                        e[1] = Message(role="user", blocks=[TextBlock(text=text)])
                        out.append(e)
                        replaced = True
                else:
                    out.append(e)
            entries[:] = out

    def stats(self) -> dict[str, Any]:
        events = self.store.list_events(self.id)
        return {"session_id": self.id, "events": len(events)}

    def export_markdown(self) -> str:
        """导出会话为 Markdown 转写（用户/助手/工具调用）。"""
        import json as _json

        lines = [f"# 会话 {self.id}", ""]
        for m in self.messages():
            if m.role == "user":
                lines += ["## 🧑 用户", "", m.text(), ""]
            elif m.role == "assistant":
                for b in m.blocks:
                    if hasattr(b, "input"):
                        lines += [
                            f"**🔧 {b.name}**",
                            "",
                            "```json",
                            _json.dumps(b.input, ensure_ascii=False, indent=2)[:2000],
                            "```",
                            "",
                        ]
                if m.text():
                    lines += ["## 🤖 助手", "", m.text(), ""]
        return "\n".join(lines)
