"""语义/自由记忆库：项目级 Markdown 文件目录（DESIGN.md §4.4，文件优先）。

事实与笔记按需以 memory_* 工具读写（JIT 检索，不自动全量注入）；路径安全限制在 root 内。
"""

from __future__ import annotations

from pathlib import Path

MAX_FILE_CHARS = 50_000


class MemoryVault:
    def __init__(self, data_dir: Path, workspace_root: Path):
        import hashlib

        key = hashlib.sha1(str(Path(workspace_root).resolve()).lower().encode("utf-8")).hexdigest()[:12]
        self.root = Path(data_dir) / "memory" / "projects" / key
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, path: str) -> Path:
        rel = (path or "/").strip("/")
        p = (self.root / rel).resolve() if rel else self.root
        if not p.is_relative_to(self.root):
            raise ValueError(f"memory path '{path}' escapes the memory directory")
        return p

    def list_dir(self, rel: str = "") -> str:
        p = self.resolve(rel)
        if not p.exists():
            return f"[empty: {rel or '/'}]"
        if p.is_file():
            return f"{rel}: {p.stat().st_size} bytes"
        items = sorted(p.iterdir(), key=lambda x: x.name)
        if not items:
            return f"[empty: {rel or '/'}]"
        lines = [
            f"{'d' if i.is_dir() else 'f'} {i.relative_to(self.root).as_posix()}({'' if i.is_dir() else f'{i.stat().st_size}b'})"
            for i in items
        ]
        return "\n".join(lines)

    def read(self, rel: str) -> str:
        p = self.resolve(rel)
        if not p.exists() or not p.is_file():
            raise FileNotFoundError(f"memory file '{rel}' does not exist")
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text) > MAX_FILE_CHARS:
            text = text[:MAX_FILE_CHARS] + "\n[truncated: use memory_update with markers or split the file]"
        return text

    def write(self, rel: str, content: str) -> str:
        p = self.resolve(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        existed = p.exists()
        p.write_text(content, encoding="utf-8")
        return f"ok: {'overwrote' if existed else 'created'} memory:{rel} ({len(content)} chars)"

    def update(self, rel: str, old_str: str, new_str: str) -> str:
        p = self.resolve(rel)
        text = self.read(rel)
        n = text.count(old_str)
        if n == 0:
            raise ValueError("old_str not found; memory_view the file first and copy exact text")
        if n > 1:
            raise ValueError(f"old_str occurs {n} times; include more surrounding lines to be unique")
        p.write_text(text.replace(old_str, new_str, 1), encoding="utf-8")
        return f"ok: updated memory:{rel}"

    def delete(self, rel: str) -> str:
        p = self.resolve(rel)
        if p == self.root:
            raise ValueError("cannot delete the memory root")
        if not p.exists():
            raise FileNotFoundError(f"memory path '{rel}' does not exist")
        import shutil

        if p.is_dir():
            shutil.rmtree(p)
            return f"ok: deleted memory directory {rel}"
        p.unlink()
        return f"ok: deleted memory:{rel}"

    def search(self, query: str, limit: int = 50) -> str:
        import re

        rx = re.compile(query, re.IGNORECASE)
        matches: list[str] = []
        for p in sorted(self.root.rglob("*")):
            if not p.is_file() or p.stat().st_size > 1_000_000:
                continue
            rel = p.relative_to(self.root).as_posix()
            try:
                for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                    if rx.search(line):
                        matches.append(f"memory:{rel}:{i}: {line.strip()[:200]}")
                        if len(matches) >= limit:
                            return "\n".join(matches) + f"\n[truncated at {limit} matches]"
            except OSError:
                continue
        return "\n".join(matches) if matches else f"[no matches for '{query}']"
