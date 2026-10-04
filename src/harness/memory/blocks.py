"""短期记忆：MemoryBlocks（DESIGN.md §4.4，学 Letta）。

常驻上下文的可编辑记忆块，带字符上限与用量元数据；按会话持久化；agent 用 block_set/block_delete 自编辑。
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

DEFAULT_BLOCK_LIMIT = 5000


class MemoryBlock(BaseModel):
    label: str
    value: str = ""
    description: str = ""
    limit_chars: int = DEFAULT_BLOCK_LIMIT


class BlockStore:
    """一个会话的 blocks；JSON 持久化，进程重启可恢复。"""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._blocks: dict[str, MemoryBlock] = {}
        if self.path.exists():
            for d in json.loads(self.path.read_text(encoding="utf-8")):
                b = MemoryBlock(**d)
                self._blocks[b.label] = b

    @classmethod
    def for_session(cls, data_dir: Path, session_id: str) -> "BlockStore":
        return cls(Path(data_dir) / "memory" / "blocks" / f"{session_id}.json")

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps([b.model_dump() for b in self._blocks.values()], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def set(self, label: str, value: str, description: str = "", limit_chars: int = DEFAULT_BLOCK_LIMIT) -> MemoryBlock:
        if len(value) > limit_chars:
            raise ValueError(
                f"block '{label}' would be {len(value)} chars, over the limit of {limit_chars}. "
                "Shorten the value — keep only high-signal state."
            )
        b = self._blocks.get(label) or MemoryBlock(label=label, limit_chars=limit_chars)
        b.value = value
        if description:
            b.description = description
        b.limit_chars = limit_chars
        self._blocks[label] = b
        self._save()
        return b

    def delete(self, label: str) -> bool:
        if label not in self._blocks:
            return False
        del self._blocks[label]
        self._save()
        return True

    def all(self) -> list[MemoryBlock]:
        return list(self._blocks.values())

    def render(self) -> str:
        """渲染进 system prompt 的 blocks 区（带用量元数据，学 Letta 的 chars_current/limit）。"""
        if not self._blocks:
            return ""
        lines = ["<memory_blocks>", "(Your working memory. Edit with block_set / block_delete.)"]
        for b in self._blocks.values():
            lines.append(
                f'<block label="{b.label}" chars="{len(b.value)}/{b.limit_chars}"'
                + (f' note="{b.description}"' if b.description else "")
                + ">"
            )
            lines.append(b.value or "(empty)")
            lines.append("</block>")
        lines.append("</memory_blocks>")
        return "\n".join(lines)


def render_blocks_suffix(blocks: BlockStore | None) -> str:
    if blocks is None:
        return ""
    r = blocks.render()
    return f"\n\n{r}" if r else ""
