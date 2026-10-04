"""上下文引擎（DESIGN.md §4.5）：大结果外置 → 旧工具结果清理 → 摘要压缩。

压缩只追加 COMPACTION 事件并重建视图，原始事件永不丢（事件溯源，可重放/可审计）。
触发数字对齐业界：清理触发 input_tokens > 30K、摘要触发 > 85% 窗口、保留最近 N 轮原始消息。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

from ..core.events import EventType
from ..core.messages import Message, TextBlock
from ..providers import BaseProvider

SUMMARY_SYSTEM = (
    "You compress an agent conversation so work can continue seamlessly in a fresh context. "
    "Output exactly these sections and be specific; keep file paths, commands and constraints verbatim; "
    "do not omit constraints:\n"
    "## Session intent\n## Key decisions\n## Artifacts created (paths)\n"
    "## Unresolved errors / open questions\n## Next steps"
)

NoticeCallback = Callable[[str], None]


def _block_chars(b) -> int:
    if hasattr(b, "text"):
        return len(b.text)
    if hasattr(b, "input"):
        return len(json.dumps(b.input, ensure_ascii=False))
    if hasattr(b, "content"):
        return len(b.content)
    return 0


def _render(entries) -> str:
    lines = []
    for seq, m in entries:
        parts = [f"--- [{seq}] {m.role} ---"]
        for b in m.blocks:
            if hasattr(b, "text"):
                parts.append(b.text)
            elif hasattr(b, "input"):
                parts.append(f"tool_call {b.name}({json.dumps(b.input, ensure_ascii=False)[:500]})")
            elif hasattr(b, "content"):
                parts.append(f"tool_result: {b.content[:500]}")
        lines.append("\n".join(parts))
    return "\n\n".join(lines)


def _recent_files(entries, limit: int = 5) -> list[str]:
    files: list[str] = []
    for _, m in reversed(entries):
        for b in m.blocks:
            inp = getattr(b, "input", None)
            if isinstance(inp, dict) and inp.get("path"):
                f = str(inp["path"])
                if f not in files:
                    files.append(f)
                    if len(files) >= limit:
                        return files
    return files


class ContextEngine:
    def __init__(
        self,
        summarizer: BaseProvider | None = None,
        *,
        context_window: int = 128_000,
        clear_trigger: int = 30_000,
        clear_keep: int = 3,
        offload_threshold: int = 10_000,
        data_dir: Path | None = None,
    ):
        self.summarizer = summarizer
        self.context_window = context_window
        self.clear_trigger = clear_trigger
        self.clear_keep = clear_keep
        self.offload_threshold = offload_threshold
        self.data_dir = Path(data_dir) if data_dir else Path.home() / ".my-harness"

    # —— 执行期：大结果外置（可还原压缩：丢内容必须留指针） ——
    def offload_result(self, session_id: str, content: str) -> str:
        if len(content) < self.offload_threshold:
            return content
        target = self.data_dir / "artifacts" / session_id / f"tool_result_{int(time.time() * 1000)}.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        preview = "\n".join(content.splitlines()[:10])
        return (
            f"[tool result offloaded to {target} ({len(content)} chars). "
            f"Preview (first 10 lines):\n{preview}\n...(re-run the tool or read that file for more)]"
        )

    def estimate(self, messages) -> int:
        return sum(_block_chars(b) for m in messages for b in m.blocks) // 4

    # —— 每轮入口：按退化阶梯触发 ——
    async def maybe_condense(
        self, session, last_input_tokens: int, on_notice: NoticeCallback | None = None
    ) -> str | None:
        if last_input_tokens > int(0.85 * self.context_window):
            note = await self.summarize(session)
        elif last_input_tokens > self.clear_trigger:
            note = self.clear_old_tool_results(session)
        else:
            return None
        if note and on_notice:
            on_notice(note)
        return note

    # —— 第一级：清理旧工具结果（最近 keep 轮保留原文） ——
    def clear_old_tool_results(self, session, keep: int | None = None) -> str | None:
        keep = self.clear_keep if keep is None else keep
        entries = session.messages_with_seq()
        rounds = [i for i, (_, m) in enumerate(entries) if m.role == "tool"]
        if len(rounds) <= keep:
            return None
        cleared = []
        for i in rounds[:-keep]:
            seq, m = entries[i]
            for bi, b in enumerate(m.blocks):
                if hasattr(b, "content"):
                    cleared.append(
                        {"seq": seq, "block_index": bi, "tool_use_id": b.tool_use_id, "chars": len(b.content)}
                    )
        if not cleared:
            return None
        session.store.append(
            session.id, EventType.COMPACTION, {"kind": "clear_tool_results", "cleared": cleared}
        )
        return f"cleared {len(cleared)} old tool result(s) (kept last {keep} rounds)"

    # —— 第二级：结构化摘要压缩 ——
    async def summarize(self, session, keep_recent: int = 6) -> str | None:
        if self.summarizer is None:
            return None
        entries = session.messages_with_seq()
        if len(entries) <= keep_recent + 2:
            return None
        covered = entries[:-keep_recent]

        transcript_path = (
            self.data_dir / "artifacts" / session.id / f"compaction_{int(time.time() * 1000)}.txt"
        )
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript = _render(covered)
        transcript_path.write_text(transcript, encoding="utf-8")

        result = await self.summarizer.chat(
            system=SUMMARY_SYSTEM,
            messages=[Message(role="user", blocks=[TextBlock(text=transcript[:120_000])])],
            tools=[],
        )
        session.store.append(
            session.id,
            EventType.COMPACTION,
            {
                "kind": "summarize",
                "covered_seq": [covered[0][0], covered[-1][0]],
                "summary": result.text,
                "transcript_path": str(transcript_path),
                "recent_files": _recent_files(covered),
            },
        )
        return f"compacted {len(covered)} messages into a summary (transcript: {transcript_path.name})"
