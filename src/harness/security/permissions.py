"""权限规则引擎（DESIGN.md §4.8）：deny → ask → allow 先匹配先赢。

规则语法对齐 Claude Code：`Tool` 或 `Tool(specifier)`，如 `Bash(git push *)`、`Edit(/src/**)`；
工具名部分支持通配（`mcp__*`）。工具定义始终保留在上下文中（mask-not-remove，护 KV-cache）。
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

_FILE_WRITE_TOOLS = {"write_file", "edit_file"}


@dataclass
class Rule:
    tool: str  # 可含通配符
    pattern: str | None  # None = 裸工具规则（匹配任意参数）


def parse_rule(text: str) -> Rule:
    text = text.strip()
    if "(" in text and text.endswith(")"):
        tool, _, rest = text.partition("(")
        return Rule(tool.strip(), rest[:-1].strip())
    return Rule(text, None)


def _matches(rule: Rule, tool: str, target: str) -> bool:
    if not fnmatch.fnmatch(tool, rule.tool):
        return False
    if rule.pattern is None:
        return True
    return fnmatch.fnmatch(target, rule.pattern)


Asker = Callable[[str, str], Awaitable[str]]  # (描述, 原因) -> "yes" | "always" | "no"


class PermissionEngine:
    def __init__(
        self,
        mode: str = "default",  # default | acceptEdits | plan | dontAsk | bypass
        allow: list[str] | tuple[str, ...] = (),
        deny: list[str] | tuple[str, ...] = (),
        ask: list[str] | tuple[str, ...] = (),
        asker: Asker | None = None,
    ):
        self.mode = mode
        self.deny_rules = [parse_rule(r) for r in deny]
        self.ask_rules = [parse_rule(r) for r in ask]
        self.allow_rules = [parse_rule(r) for r in allow]
        self.session_allow: list[Rule] = []  # 用户选「总是允许」时追加
        self.asker = asker

    @staticmethod
    def target_of(tool: str, args: dict[str, Any]) -> str:
        if tool == "bash":
            return str(args.get("command", ""))
        for key in ("path", "glob", "pattern"):
            if key in args:
                return str(args[key])
        return ""

    @staticmethod
    def _first(rules: list[Rule], tool: str, target: str) -> Rule | None:
        for r in rules:
            if _matches(r, tool, target):
                return r
        return None

    async def gate(self, tool: str, args: dict[str, Any], read_only: bool = False) -> tuple[bool, str]:
        """返回 (allowed, detail)；detail 写进事件与给模型的拒绝消息。"""
        target = self.target_of(tool, args)
        if self.mode == "bypass":
            return True, "mode:bypass"
        if r := self._first(self.deny_rules, tool, target):
            return False, f"rule {r.tool}({r.pattern or ''})"
        if self.mode == "plan" and not read_only:
            return False, "plan mode is read-only"
        if r := self._first(self.allow_rules + self.session_allow, tool, target):
            return True, f"rule {r.tool}({r.pattern or ''})"
        if self._first(self.ask_rules, tool, target):
            return await self._ask(tool, target, "requires explicit approval")
        if read_only:
            return True, "read-only tool"
        if self.mode == "acceptEdits" and tool in _FILE_WRITE_TOOLS:
            return True, "mode:acceptEdits"
        if self.mode == "dontAsk":
            return False, "mode dontAsk auto-denies unapproved actions"
        return await self._ask(tool, target, "not covered by any permission rule")

    async def _ask(self, tool: str, target: str, reason: str) -> tuple[bool, str]:
        if self.asker is None:
            return False, f"approval required for '{tool}' but no approval channel is available"
        answer = await self.asker(f"{tool}: {target}"[:300], reason)
        if answer == "always":
            self.session_allow.append(Rule(tool, None))
            return True, "user allowed (always, this session)"
        if answer == "yes":
            return True, "user allowed (once)"
        return False, "user denied"
