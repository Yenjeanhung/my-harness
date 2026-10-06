"""编辑器 LSP 桥（PROTOCOL.md M6）：daemon 作为哑管道，在渲染层与语言服务器子进程间转发 JSON-RPC。

为什么不解析 LSP：协议「只增不改」，daemon 不需要懂 LSP 语义——渲染层的 monaco 内置
LSP 客户端（monaco.lsp.MonacoLspClient）承担补全/悬停/诊断/格式化等全部逻辑，daemon
只负责 spawn 语言服务器（stdio + Content-Length 帧）并在 WS 协议里原样搬运消息。

命令：LspStart / LspToServer / LspStop（见 app.py _dispatch）
事件：LspStatus(starting|running|stopped|error, root_uri, detail) / LspFromServer(message)

语言服务器解析顺序：settings.json 的 lsp.<language>.command（列表）→ 内置自动探测
（python: pyright-langserver → pylsp）。找不到时回 LspStatus(error) 给前端提示，
编辑器退回 daemon 内建校验（LintCheck）与 GotoDef 兜底，功能不倒退。
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

# 各语言缺省命令（按顺序探测 PATH）；settings["lsp"][language]["command"] 优先
AUTODETECT: dict[str, list[list[str]]] = {
    "python": [
        ["pyright-langserver", "--stdio"],
        ["pylsp"],
    ],
}

READ_CHUNK = 65536


def _resolve_command(language: str, settings: dict[str, Any], workspace: Path | None = None) -> tuple[list[str] | None, str]:
    """返回 (命令, 说明)。settings 覆盖 > 工作区 .venv > PATH 自动探测；找不到返回 (None, 原因)。

    工作区 .venv 优先于 PATH：PATH 上的语言服务器（如全局 anaconda 的 pylsp）带的 jedi/parso
    可能不支持项目解释器的语法版本（jedi 自动切到项目 .venv 的 3.13 语法、旧 parso 直接解析
    失败，定义/悬停全空）——venv 自带的语言服务器与项目环境天然匹配。
    """
    custom = (settings.get("lsp") or {}).get(language) or {}
    cmd = custom.get("command")
    if isinstance(cmd, list) and cmd and all(isinstance(x, str) for x in cmd):
        resolved = shutil.which(cmd[0]) or cmd[0]  # 绝对路径直接用，裸名尽量解析
        if resolved:
            return [resolved, *cmd[1:]], cmd[0]

    def _local_exe(name: str) -> str | None:
        if workspace is None:
            return None
        sub = "Scripts" if sys.platform == "win32" else "bin"
        exe = f"{name}.exe" if sys.platform == "win32" else name
        p = workspace / ".venv" / sub / exe
        return str(p) if p.is_file() else None

    for candidate in AUTODETECT.get(language, []):
        found = _local_exe(candidate[0]) or shutil.which(candidate[0])
        if found:
            return [found, *candidate[1:]], candidate[0]
    hint = " / ".join(c[0] for c in AUTODETECT.get(language, [])) or "（该语言未配置）"
    return None, f"未找到语言服务器（可 pip install {hint.split(' / ')[0]}，或在 settings.json 配 lsp.{language}.command）"


class LspProcess:
    """一个语言服务器子进程：stdin 帧写入、stdout 帧读取、异常退出通知。"""

    def __init__(self, language: str, command: list[str], cwd: Path, emit: Callable[[dict], None]):
        self.language = language
        self.command = command
        self.cwd = cwd
        self.emit = emit  # ServerState._notify：广播给所有 WS 客户端
        self.proc: asyncio.subprocess.Process | None = None
        self._write_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []
        self.ready = asyncio.Event()

    def _status(self, status: str, **extra: Any) -> None:
        self.emit({"type": "LspStatus", "language": self.language, "status": status, **extra})

    async def start(self) -> bool:
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.cwd),  # rootUri 之外的兜底：服务器以 cwd 为工作区根
            )
        except OSError as e:
            self._status("error", detail=f"{self.command[0]} 启动失败：{e}")
            return False
        self._status("running", root_uri=self.cwd.as_uri(), detail=Path(self.command[0]).name)
        self.ready.set()
        self._tasks = [
            asyncio.create_task(self._read_loop()),
            asyncio.create_task(self._drain_stderr()),
            asyncio.create_task(self._watch_exit()),
        ]
        return True

    async def send(self, message: dict[str, Any]) -> None:
        """渲染层 → 语言服务器：Content-Length 帧写入 stdin。"""
        await self.ready.wait()
        proc = self.proc
        if proc is None or proc.stdin is None:
            return
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        frame = b"Content-Length: %d\r\n\r\n%s" % (len(body), body)
        async with self._write_lock:
            try:
                proc.stdin.write(frame)
                await proc.stdin.drain()
            except (ConnectionResetError, BrokenPipeError):
                pass  # 服务器退出：_watch_exit 会广播 stopped

    async def _read_message(self) -> dict[str, Any] | None:
        """从 stdout 读一帧；流结束/解析失败返回 None。"""
        proc = self.proc
        assert proc and proc.stdout
        headers: dict[str, int] = {}
        while True:
            line = await proc.stdout.readline()
            if not line:
                return None
            text = line.decode("ascii", "replace").strip()
            if not text:
                break  # 空行 = 头结束
            name, _, value = text.partition(":")
            if name.strip().lower() == "content-length":
                try:
                    headers["content-length"] = int(value.strip())
                except ValueError:
                    return None
        length = headers.get("content-length")
        if length is None or length <= 0 or length > 64 * 1024 * 1024:
            return None
        try:
            body = await proc.stdout.readexactly(length)
        except (asyncio.IncompleteReadError, ValueError):
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    async def _read_loop(self) -> None:
        while True:
            message = await self._read_message()
            if message is None:
                break
            self.emit({"type": "LspFromServer", "language": self.language, "message": message})

    async def _drain_stderr(self) -> None:
        proc = self.proc
        assert proc and proc.stderr
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").strip()
            if text:
                print(f"[lsp:{self.language}] {text[:300]}")

    async def _watch_exit(self) -> None:
        proc = self.proc
        assert proc
        code = await proc.wait()
        self.ready.clear()
        self._status("stopped", detail=f"进程退出（code={code}）")

    async def stop(self) -> None:
        proc = self.proc
        if proc is None:
            return
        for t in self._tasks:
            t.cancel()
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        self.proc = None


class LspManager:
    """按语言管理 LspProcess；随 daemon 生命周期启停。"""

    def __init__(self, workspace: Path, settings: dict[str, Any], emit: Callable[[dict], None]):
        self.workspace = workspace.resolve()
        self.settings = settings
        self.emit = emit
        self.procs: dict[str, LspProcess] = {}

    async def start(self, language: str) -> None:
        # LspStart 语义 = 确保一个「新」会话：已有进程也重启。LSP 的 initialize 每进程只允许一次，
        # 页面重载后的客户端必须重新走 initialize——复用旧进程会让第二次 initialize 报错、
        # 能力协商全部失败（补全/悬停静默失效）。冷启动几秒，换来每次连接状态干净。
        old = self.procs.pop(language, None)
        if old:
            await old.stop()
        command, detail = _resolve_command(language, self.settings, self.workspace)
        if command is None:
            self.emit({"type": "LspStatus", "language": language, "status": "error", "detail": detail})
            return
        proc = LspProcess(language, command, self.workspace, self.emit)
        self.procs[language] = proc
        await proc.start()

    async def forward(self, language: str, message: dict[str, Any]) -> None:
        proc = self.procs.get(language)
        if proc is None:
            self.emit({
                "type": "LspStatus",
                "language": language,
                "status": "error",
                "detail": "语言服务器未启动（先发 LspStart）",
            })
            return
        await proc.send(message)

    async def stop(self, language: str) -> None:
        proc = self.procs.pop(language, None)
        if proc:
            await proc.stop()

    async def shutdown(self) -> None:
        for language in list(self.procs):
            await self.stop(language)
