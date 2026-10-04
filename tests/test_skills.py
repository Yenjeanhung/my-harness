import asyncio

from harness.tools.base import ToolContext, ToolRegistry
from harness.tools.skills import SkillRegistry, build_skill_tools


def make_skill(root, name, desc, body):
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\n\n{body}", encoding="utf-8")


def test_discovery_summary_and_load(tmp_path):
    make_skill(tmp_path / "skills", "xlsx", "Handle Excel files", "Use openpyxl: load workbook, iterate sheets.")
    make_skill(tmp_path / "skills", "git", "Git workflows", "Always rebase before push.")

    reg = SkillRegistry([tmp_path / "skills"])
    assert reg.load() == 2
    assert {s.name for s in reg.all()} == {"xlsx", "git"}
    summary = reg.summary()
    assert "xlsx" in summary and "Handle Excel files" in summary  # L1：只有元数据进 prompt
    assert "openpyxl" not in summary  # L2 正文不进 prompt

    ctx = ToolContext(workspace_root=tmp_path, data_dir=tmp_path, skills=reg)
    tr = ToolRegistry()
    for t in build_skill_tools(reg):
        tr.register(t)
    r = asyncio.run(tr.execute("load_skill", {"name": "xlsx"}, tool_use_id="t1", ctx=ctx))
    assert not r.is_error and "openpyxl" in r.content  # L2：按需载入正文
    r = asyncio.run(tr.execute("load_skill", {"name": "nope"}, tool_use_id="t2", ctx=ctx))
    assert r.is_error and "not found" in r.content


def test_empty_registry_summary(tmp_path):
    reg = SkillRegistry([tmp_path / "missing"])
    reg.load()
    assert reg.summary() == ""
