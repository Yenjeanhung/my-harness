"""Shadow 快照/回滚（DESIGN.md §4.7，学 gemini-cli 的 shadow git）。

harness 通过 write_file/edit_file 修改文件前自动快照当前内容；/rollback 恢复到任一检查点
（快照时不存在 → 回滚时删除）。bash 的任意修改不在覆盖范围（M1 已知边界，文档已注明）。
存储在 data_dir/history/<workspace-hash>/<checkpoint>/，纯文件复制，无 git 依赖。
"""

from __future__ import annotations

import hashlib
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


class ShadowCheckpoint:
    def __init__(self, data_dir: Path, workspace_root: Path):
        self.workspace_root = Path(workspace_root).resolve()
        key = hashlib.sha1(str(self.workspace_root).lower().encode("utf-8")).hexdigest()[:12]
        self.base = Path(data_dir) / "history" / key

    def snapshot(self, paths: list[str | Path], label: str = "") -> str | None:
        """对给定路径（当前内容）打快照；全部不在工作区内则返回 None。"""
        ckpt = f"{int(time.time() * 1000):x}-{uuid.uuid4().hex[:6]}"
        files_dir = self.base / ckpt / "files"
        entries: list[dict] = []
        for raw in paths:
            p = Path(raw).expanduser()
            if not p.is_absolute():
                p = self.workspace_root / p
            try:
                p = p.resolve()
                rel = p.relative_to(self.workspace_root).as_posix()
            except ValueError:
                continue  # 工作区外不追踪
            entry: dict = {"path": rel}
            if p.exists() and p.is_file():
                dest = files_dir.joinpath(*Path(rel).parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dest)
                entry["present"] = True
            else:
                entry["present"] = False
            entries.append(entry)
        if not entries:
            return None
        manifest = {
            "id": ckpt,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "label": label,
            "files": entries,
        }
        import json

        manifest_path = self.base / ckpt / "manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return ckpt

    def list(self) -> list[dict]:
        import json

        manifests = sorted(self.base.glob("*/manifest.json"), reverse=True)
        return [json.loads(m.read_text(encoding="utf-8")) for m in manifests]

    def restore(self, checkpoint_id: str) -> dict:
        import json

        manifest_path = self.base / checkpoint_id / "manifest.json"
        if not manifest_path.exists():
            raise FileNotFoundError(f"checkpoint not found: {checkpoint_id}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        restored: list[str] = []
        removed: list[str] = []
        for entry in manifest["files"]:
            target = self.workspace_root.joinpath(*Path(entry["path"]).parts)
            if entry["present"]:
                backup = self.base / checkpoint_id / "files" / entry["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
                restored.append(entry["path"])
            else:
                if target.exists():
                    target.unlink()
                removed.append(entry["path"])
        return {"id": checkpoint_id, "restored": restored, "removed": removed}
