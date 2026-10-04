"""Agent Skills（DESIGN.md §4.3.4，对齐 agentskills.io）：SKILL.md 渐进式披露。

L1：name+description 常驻 system prompt（~100 token）；L2：判定相关后 load_skill 载入正文；
L3：scripts/references 由 agent 按需读取/执行（经由既有文件与 bash 工具，无需额外机制）。
"""

from __future__ import annotations

from pathlib import Path

from .base import Tool, ToolSpec


class Skill:
    def __init__(self, name: str, description: str, body: str, path: Path):
        self.name = name
        self.description = description
        self.body = body
        self.path = path


def _parse_skill_md(path: Path) -> Skill | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return None
    try:
        _, fm, body = text.split("---", 2)
    except ValueError:
        return None
    meta: dict[str, str] = {}
    for line in fm.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip().lower()] = value.strip()
    name = meta.get("name") or path.parent.name
    description = meta.get("description", "")
    if not description:
        return None
    return Skill(name=name, description=description, body=body.strip(), path=path.parent)


class SkillRegistry:
    def __init__(self, dirs: list[Path]):
        self.dirs = [Path(d) for d in dirs]
        self._skills: dict[str, Skill] = {}

    def load(self) -> int:
        self._skills.clear()
        for d in self.dirs:
            if not d.exists():
                continue
            for skill_md in sorted(d.glob("*/SKILL.md")):
                skill = _parse_skill_md(skill_md)
                if skill:
                    self._skills[skill.name] = skill
        return len(self._skills)

    def all(self) -> list[Skill]:
        return list(self._skills.values())

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def summary(self) -> str:
        """L1 注入：仅 name + description（metadata 常驻，正文按需）。"""
        if not self._skills:
            return ""
        lines = [
            "## Available skills",
            "Load a skill's full instructions with the load_skill tool when the task matches:",
        ]
        for s in self._skills.values():
            lines.append(f"- {s.name}: {s.description}")
        return "\n".join(lines)


async def _load_skill(args, ctx):
    skill = ctx.skills.get(args["name"]) if getattr(ctx, "skills", None) else None
    if skill is None:
        raise ValueError(f"skill '{args['name']}' not found")
    return (
        f"[skill: {skill.name} | source: {skill.path}]\n\n"
        f"{skill.body}\n\n"
        "[Skill files live next to SKILL.md: read scripts/references with read_file when needed.]"
    )


def build_skill_tools(registry: SkillRegistry) -> list[Tool]:
    return [
        Tool(
            ToolSpec(
                name="load_skill",
                description=(
                    "Load the full instructions of a named skill (progressive disclosure). "
                    "Call this when the current task matches a skill listed in the system prompt."
                ),
                parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
                read_only=True,
            ),
            _load_skill,
        )
    ]
