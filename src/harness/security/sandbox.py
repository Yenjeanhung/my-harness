"""沙箱适配器（DESIGN.md §4.8）：DockerSandbox 把 bash 执行放进容器——工作区挂载、网络默认关闭。

文件工具仍在宿主执行（工作区就是挂载目录）；Windows 需要 Docker Desktop/WSL2 后端。
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path


class DockerSandbox:
    def __init__(
        self,
        image: str = "python:3.12-slim",
        workdir: str = "/workspace",
        network: bool = False,
        memory: str | None = None,
    ):
        self.image = image
        self.workdir = workdir
        self.network = network
        self.memory = memory

    async def run(self, command: str, workspace_root: Path, timeout: int = 180) -> tuple[int, str]:
        name = f"myharness-{uuid.uuid4().hex[:10]}"
        args = [
            "docker", "run", "--rm", "--name", name,
            "-w", self.workdir,
            "-v", f"{Path(workspace_root).resolve()}:{self.workdir}",
        ]
        if not self.network:
            args += ["--network", "none"]
        if self.memory:
            args += ["--memory", self.memory]
        args += [self.image, "sh", "-c", command]

        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            killer = await asyncio.create_subprocess_exec(
                "docker", "kill", name,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
            return 124, f"command timed out after {timeout}s (container killed)"
        text = out.decode("utf-8", errors="replace")
        if len(text) > 30_000:
            text = text[:30_000] + "\n[output truncated]"
        return proc.returncode, text
