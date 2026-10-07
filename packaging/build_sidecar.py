"""带缓存的 sidecar 构建：src/harness 与 server_entry.py 没变就复用上次产物。

PyInstaller 全量构建要几分钟（litellm/langchain 等 10 个 collect_all 是大头），
日常只改 Python 源码以外的内容（前端/打包配置）时完全不必重打。
用法（venv 激活状态下，项目根目录）：python packaging/build_sidecar.py
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAMP = Path(__file__).resolve().parent / ".build_hash"
# onedir 产物：dist/harness-server/ 目录，入口 exe 在目录顶层（依赖在 _internal/）
EXE_CANDIDATES = [
    ROOT / "dist" / "harness-server" / "harness-server.exe",
    ROOT / "packaging" / "dist" / "harness-server" / "harness-server.exe",
]
# 历史 onefile 产物：重建成功后清掉，免得旧单文件继续被误用/占 100MB+
STALE_ONEFILE = [ROOT / "dist" / "harness-server.exe", ROOT / "packaging" / "dist" / "harness-server.exe"]


def fingerprint() -> str:
    """参与产物的全部输入：harness 源码 + 入口脚本 + 构建定义（spec/脚本）+ PyInstaller 版本。"""
    h = hashlib.sha256()
    for p in sorted((ROOT / "src" / "harness").rglob("*.py")):
        h.update(p.name.encode())
        h.update(p.read_bytes())
    for extra in ("packaging/server_entry.py", "packaging/harness-server.spec", "packaging/build_sidecar.py"):
        h.update((ROOT / extra).read_bytes())
    ver = subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--version"], capture_output=True, text=True
    )
    h.update(ver.stdout.strip().encode())
    return h.hexdigest()


def find_exe() -> Path | None:
    for e in EXE_CANDIDATES:
        if e.is_file():
            return e
    return None


def main() -> int:
    fp = fingerprint()
    exe = find_exe()
    if STAMP.exists() and exe and STAMP.read_text().strip() == fp:
        print(f"[sidecar] 源码未变，复用现有产物：{exe}")
        return 0
    print("[sidecar] 输入有变化（或无产物），执行 PyInstaller 全量构建…")
    # 构建定义唯一来源 = packaging/harness-server.spec（collect_all 与重型包 excludes 都在里面）
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm",
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "packaging" / "build"),
        str(ROOT / "packaging" / "harness-server.spec"),
    ]
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        print("[sidecar] PyInstaller 失败")
        return r.returncode
    STAMP.write_text(fp)
    for stale in STALE_ONEFILE:
        if stale.exists():
            stale.unlink()
            print(f"[sidecar] 已清理历史 onefile 产物：{stale}")
    print(f"[sidecar] 完成：{find_exe()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
