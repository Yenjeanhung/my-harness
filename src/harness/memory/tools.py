"""记忆工具（记忆即工具，DESIGN.md §4.4）：Anthropic memory 六命令最小集 + blocks + 情景检索。"""

from __future__ import annotations

from ..tools.base import Tool, ToolSpec
from .blocks import BlockStore
from .vault import MemoryVault


def _spec(name, description, properties, required, read_only=False):
    return Tool(
        ToolSpec(
            name=name,
            description=description,
            parameters={"type": "object", "properties": properties, "required": required},
            read_only=read_only,
        ),
        globals()[f"_{name}"],
    )


# —— blocks（短期，常驻上下文） ——
async def _block_set(args, ctx):
    if ctx.blocks is None:
        raise RuntimeError("no memory block store bound to this session")
    b = ctx.blocks.set(
        args["label"],
        args["value"],
        description=args.get("description", ""),
        limit_chars=int(args.get("limit_chars", 5000)),
    )
    return f"ok: block '{b.label}' set ({len(b.value)}/{b.limit_chars} chars). It is now pinned in your context."


async def _block_delete(args, ctx):
    if ctx.blocks is None:
        raise RuntimeError("no memory block store bound to this session")
    if not ctx.blocks.delete(args["label"]):
        raise ValueError(f"block '{args['label']}' does not exist")
    return f"ok: block '{args['label']}' deleted"


# —— vault（长期，按需检索） ——
async def _memory_view(args, ctx):
    return ctx.vault.list_dir(args.get("path", ""))


async def _memory_read(args, ctx):
    return ctx.vault.read(args["path"])


async def _memory_write(args, ctx):
    return ctx.vault.write(args["path"], args["content"])


async def _memory_update(args, ctx):
    return ctx.vault.update(args["path"], args["old_str"], args["new_str"])


async def _memory_delete(args, ctx):
    return ctx.vault.delete(args["path"])


async def _memory_search(args, ctx):
    return ctx.vault.search(args["query"], limit=int(args.get("limit", 50)))


# —— 情景：事件日志检索（原始日志永不删，只检索） ——
async def _search_history(args, ctx):
    store = ctx.event_store
    query = args["query"]
    rows = store.search(query, limit=int(args.get("limit", 20)))
    if not rows:
        return f"[no history matches for '{query}']"
    lines = [f"[session {r['session_id'][:8]}] {r['snippet']}" for r in rows]
    return "\n".join(lines)


def build_memory_tools(vault: MemoryVault) -> list[Tool]:
    return [
        _spec(
            "block_set",
            "Write to one of your working-memory blocks that stays pinned in your context across turns. "
            "Keep only high-signal live state: current goal, key decisions, TODOs.",
            {
                "label": {"type": "string"},
                "value": {"type": "string"},
                "description": {"type": "string"},
                "limit_chars": {"type": "integer"},
            },
            ["label", "value"],
        ),
        _spec("block_delete", "Delete a working-memory block by label.", {"label": {"type": "string"}}, ["label"]),
        _spec(
            "memory_view",
            "List the persistent memory directory (or a subdirectory), or read a single file with memory_read.",
            {"path": {"type": "string"}},
            [],
            read_only=True,
        ),
        _spec("memory_read", "Read a file from persistent memory (e.g. 'facts.md').", {"path": {"type": "string"}}, ["path"], read_only=True),
        _spec(
            "memory_write",
            "Create or overwrite a persistent memory file (Markdown). Survives across sessions for this project.",
            {"path": {"type": "string"}, "content": {"type": "string"}},
            ["path", "content"],
        ),
        _spec(
            "memory_update",
            "Replace one exact occurrence of old_str in a memory file (like edit_file).",
            {"path": {"type": "string"}, "old_str": {"type": "string"}, "new_str": {"type": "string"}},
            ["path", "old_str", "new_str"],
        ),
        _spec("memory_delete", "Delete a memory file or directory.", {"path": {"type": "string"}}, ["path"]),
        _spec(
            "memory_search",
            "Search all persistent memory files for a regex; returns 'memory:path:line: text' matches.",
            {"query": {"type": "string"}, "limit": {"type": "integer"}},
            ["query"],
            read_only=True,
        ),
        _spec(
            "search_history",
            "Search past conversation events (all sessions) by keyword — episodic memory. "
            "Use to recall what happened in earlier sessions.",
            {"query": {"type": "string"}, "limit": {"type": "integer"}},
            ["query"],
            read_only=True,
        ),
    ]
