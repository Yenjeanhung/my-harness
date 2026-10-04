"""PyInstaller sidecar 入口：打包为 harness-server.exe，供桌面端拉起本地 daemon。

打包命令见根目录 PACKAGING.md。
"""

from __future__ import annotations

import argparse

import uvicorn

from harness.config import load_config
from harness.server.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="my-harness local daemon (sidecar)")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    cfg = load_config()
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
