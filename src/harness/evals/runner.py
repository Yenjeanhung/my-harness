"""评测 harness（DESIGN.md §4.9，术语对齐 Anthropic《Demystifying Evals》）：

Task（用例 JSON：prompt + grader）/ Trial（单次运行）/ Grader（打分器）。
原则：评产出不评路径；多 trial 统计 pass@k（至少一次成功）与 pass^k（k 次全成功）。
grader 类型：contains / regex / file_exists（相对该用例的临时工作区）。
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..core.events import EventStore
from ..core.session import Session
from ..loop.react import Budget, ReActLoop
from ..tools.base import ToolContext
from ..tools.builtin import build_default_registry


@dataclass
class EvalCase:
    name: str
    prompt: str
    grader: dict[str, Any] = field(default_factory=dict)


def load_cases(path: Path) -> list[EvalCase]:
    """从目录（*.json）或单文件加载用例。"""
    files = [path] if path.is_file() else sorted(path.glob("*.json"))
    cases = []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        cases.append(
            EvalCase(
                name=data.get("name") or f.stem,
                prompt=data["prompt"],
                grader=data.get("grader", {}),
            )
        )
    return cases


def grade(case: EvalCase, answer: str, workspace: Path) -> tuple[bool, str]:
    g = case.grader
    gtype = g.get("type", "contains")
    if gtype == "contains":
        ok = g["text"] in answer
        return ok, f"contains {g['text']!r}"
    if gtype == "regex":
        ok = re.search(g["pattern"], answer) is not None
        return ok, f"regex {g['pattern']!r}"
    if gtype == "file_exists":
        p = workspace / g["path"]
        ok = p.exists() and p.stat().st_size > 0
        return ok, f"file_exists {g['path']}"
    return False, f"unknown grader type: {gtype}"


async def run_eval(
    cases: list[EvalCase],
    provider,
    *,
    workspace_root: Path,
    data_dir: Path,
    trials: int = 1,
    max_turns: int = 15,
    extra_tools: list | None = None,
    on_case: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """逐用例 × 逐 trial 跑 agent 并打分；每个 trial 一个干净的临时工作区。"""
    results = []
    for case in cases:
        if on_case:
            on_case(case.name)
        passes = 0
        details: list[str] = []
        answers: list[str] = []
        for ti in range(max(trials, 1)):
            case_ws = Path(workspace_root) / case.name / f"trial{ti}"  # 每 trial 干净工作区
            case_ws.mkdir(parents=True, exist_ok=True)
            registry = build_default_registry()
            for t in extra_tools or []:
                registry.register(t)
            ctx = ToolContext(workspace_root=case_ws, data_dir=Path(data_dir))
            store = EventStore(data_dir=Path(data_dir))
            sess = Session(store)
            loop = ReActLoop(provider=provider, registry=registry, ctx=ctx)
            try:
                answer = await loop.run(sess, case.prompt, budget=Budget(max_turns=max_turns))
            except Exception as e:
                answer = f"RUN_ERROR: {type(e).__name__}: {e}"
            ok, detail = grade(case, answer, case_ws)
            passes += ok
            details.append(detail)
            answers.append(answer)
        results.append(
            {
                "name": case.name,
                "trials": max(trials, 1),
                "passes": passes,
                "pass_rate": passes / max(trials, 1),
                "grader": details[0] if details else "",
                "last_answer": answers[-1][:500] if answers else "",
            }
        )
    n = len(results) or 1
    report = {
        "cases": results,
        "pass@1": sum(r["pass_rate"] for r in results) / n,
        "pass^k": sum(1 for r in results if r["passes"] == r["trials"]) / n,  # 全部 trial 成功的用例占比
        "total_cases": len(results),
    }
    return report
