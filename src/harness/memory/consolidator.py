"""后台事实整合（DESIGN.md §4.4 双写入路径中的 background 通道，学 mem0/langmem）。

运行结束后用便宜模型：① 从会话抽取候选事实 → ② 与既有 facts.md 对账（ADD/UPDATE/DELETE）→ 写回。
失败安全：任何异常只记日志，不影响主流程。
"""

from __future__ import annotations

import json
import re

from ..providers import BaseProvider
from .vault import MemoryVault

FACTS_FILE = "facts.md"

EXTRACT_SYSTEM = (
    "Extract durable facts worth remembering long-term from this agent conversation: user preferences, "
    "project structure decisions, corrections, environment quirks. Ignore transient task state. "
    "Output a JSON array of short fact strings, [] if nothing durable. Output ONLY the JSON array."
)

MERGE_SYSTEM = (
    "You maintain a Markdown memory file of durable facts (one '- ' bullet per fact, newest insight wins). "
    "Given the existing file and newly extracted candidate facts, output the COMPLETE updated file: "
    "merge duplicates, drop facts invalidated by newer ones, keep still-valid facts verbatim. "
    "Output ONLY the file content."
)


class MemoryConsolidator:
    def __init__(self, provider: BaseProvider, vault: MemoryVault, facts_file: str = FACTS_FILE):
        self.provider = provider
        self.vault = vault
        self.facts_file = facts_file

    async def consolidate(self, session) -> str | None:
        from ..core.messages import Message, TextBlock

        msgs = session.messages()
        if len(msgs) < 4:
            return None
        transcript = "\n".join(f"[{m.role}] {m.text()}" for m in msgs if m.text())[:60_000]
        if not transcript.strip():
            return None

        r1 = await self.provider.chat(
            system=EXTRACT_SYSTEM,
            messages=[Message(role="user", blocks=[TextBlock(text=transcript)])],
            tools=[],
        )
        m = re.search(r"\[.*\]", r1.text, re.DOTALL)
        if not m:
            return None
        try:
            candidates = [str(c) for c in json.loads(m.group(0)) if str(c).strip()][:20]
        except json.JSONDecodeError:
            return None
        if not candidates:
            return None

        existing = ""
        try:
            existing = self.vault.read(self.facts_file)
        except FileNotFoundError:
            pass

        payload = f"EXISTING FILE:\n{existing or '(empty)'}\n\nNEW CANDIDATE FACTS:\n" + "\n".join(
            f"- {c}" for c in candidates
        )
        r2 = await self.provider.chat(
            system=MERGE_SYSTEM,
            messages=[Message(role="user", blocks=[TextBlock(text=payload)])],
            tools=[],
        )
        merged = r2.text.strip()
        if not merged:
            return None
        self.vault.write(self.facts_file, merged)
        return f"memory consolidated: {len(candidates)} candidate fact(s) merged into memory:{self.facts_file}"
