import asyncio
import json

from harness.core.messages import ToolUseBlock
from harness.evals.runner import EvalCase, grade, load_cases, run_eval
from harness.providers import TurnResult


def test_load_cases(tmp_path):
    d = tmp_path / "cases"
    d.mkdir()
    (d / "a.json").write_text(
        json.dumps({"name": "write-case", "prompt": "write ok.txt", "grader": {"type": "file_exists", "path": "ok.txt"}}),
        encoding="utf-8",
    )
    (d / "b.json").write_text(
        json.dumps({"name": "say-case", "prompt": "say pineapple", "grader": {"type": "contains", "text": "pineapple"}}),
        encoding="utf-8",
    )
    cases = load_cases(d)
    assert [c.name for c in cases] == ["write-case", "say-case"]


def test_grade_types(tmp_path):
    assert grade(EvalCase("x", "p", {"type": "contains", "text": "ok"}), "it is ok", tmp_path)[0]
    assert not grade(EvalCase("x", "p", {"type": "contains", "text": "ok"}), "nope", tmp_path)[0]
    assert grade(EvalCase("x", "p", {"type": "regex", "pattern": r"\d+"}), "abc 123", tmp_path)[0]
    (tmp_path / "f.txt").write_text("data")
    assert grade(EvalCase("x", "p", {"type": "file_exists", "path": "f.txt"}), "done", tmp_path)[0]
    assert not grade(EvalCase("x", "p", {"type": "file_exists", "path": "missing.txt"}), "done", tmp_path)[0]


class ScriptedProvider:
    """根据用户 prompt 决定行为：写文件 or 回答关键词。"""

    async def chat(self, *, system, messages, tools, model=None, on_delta=None):
        user_text = messages[-1].text()
        if "ok.txt" in user_text:
            return TurnResult(
                text="",
                tool_uses=[ToolUseBlock(id="t1", name="write_file", input={"path": "ok.txt", "content": "done"})],
            )
        return TurnResult(text="the word is pineapple")


def test_run_eval_pass_at_k(tmp_path):
    d = tmp_path / "cases"
    d.mkdir()
    (d / "a.json").write_text(
        json.dumps({"name": "write-case", "prompt": "please write ok.txt now", "grader": {"type": "file_exists", "path": "ok.txt"}}),
        encoding="utf-8",
    )
    (d / "b.json").write_text(
        json.dumps({"name": "say-case", "prompt": "say the word pineapple", "grader": {"type": "contains", "text": "pineapple"}}),
        encoding="utf-8",
    )
    report = asyncio.run(
        run_eval(
            load_cases(d),
            ScriptedProvider(),
            workspace_root=tmp_path / "ws",
            data_dir=tmp_path / "data",
            trials=2,
        )
    )
    assert report["total_cases"] == 2
    by = {c["name"]: c for c in report["cases"]}
    assert by["write-case"]["passes"] == 2  # 每个 trial 干净工作区，文件真实写出
    assert by["say-case"]["passes"] == 2
    assert report["pass@1"] == 1.0 and report["pass^k"] == 1.0


def test_run_eval_counts_failures(tmp_path):
    d = tmp_path / "cases"
    d.mkdir()
    (d / "hard.json").write_text(
        json.dumps({"name": "hard", "prompt": "impossible task", "grader": {"type": "contains", "text": "impossible-answer"}}),
        encoding="utf-8",
    )
    report = asyncio.run(
        run_eval(load_cases(d), ScriptedProvider(), workspace_root=tmp_path / "ws", data_dir=tmp_path / "data", trials=2)
    )
    assert report["pass@1"] == 0.0 and report["pass^k"] == 0.0
