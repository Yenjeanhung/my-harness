from harness.persistence.shadow import ShadowCheckpoint


def _sc(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    return ShadowCheckpoint(data_dir=tmp_path / "data", workspace_root=ws), ws


def test_snapshot_and_restore(tmp_path):
    sc, ws = _sc(tmp_path)
    (ws / "sub").mkdir()
    (ws / "a.txt").write_text("v1")
    (ws / "sub" / "b.txt").write_text("b1")

    cid = sc.snapshot(["a.txt", "sub/b.txt"], label="before edit")
    assert cid

    (ws / "a.txt").write_text("v2")
    (ws / "sub" / "b.txt").write_text("b2")
    out = sc.restore(cid)

    assert (ws / "a.txt").read_text() == "v1"
    assert (ws / "sub" / "b.txt").read_text() == "b1"
    assert out["restored"] == ["a.txt", "sub/b.txt"]
    assert out["removed"] == []


def test_restore_deletes_file_absent_at_snapshot(tmp_path):
    sc, ws = _sc(tmp_path)
    cid = sc.snapshot(["new.txt"])  # 快照时不存在
    (ws / "new.txt").write_text("created later")
    out = sc.restore(cid)
    assert not (ws / "new.txt").exists() and out["removed"] == ["new.txt"]


def test_workspace_escape_not_tracked(tmp_path):
    sc, _ = _sc(tmp_path)
    assert sc.snapshot(["../outside.txt"]) is None


def test_list_sorted_desc(tmp_path):
    sc, ws = _sc(tmp_path)
    (ws / "a.txt").write_text("v")
    id1 = sc.snapshot(["a.txt"], label="first")
    (ws / "a.txt").write_text("v2")
    id2 = sc.snapshot(["a.txt"], label="second")
    cps = sc.list()
    assert [c["id"] for c in cps] == [id2, id1]
    assert cps[-1]["label"] == "first"
