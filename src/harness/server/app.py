"""Local Server（M1，DESIGN.md §4.11）：FastAPI + WebSocket daemon。

「内核即服务，界面皆客户端」——CLI 之外的第一个协议客户端；桌面端（Electron）将复用同一协议。
完整命令/事件参考见 PROTOCOL.md（daemon 是可编程的，任何语言都能驱动）。
事件协议：
  client→server: CreateSession / ResumeSession / ListSessions / SendMessage / CancelRun
                 / RespondPermission / SetModel / SwitchModel / DeleteModelConfig / GetSettings
                 / SetPermissionMode / SetThinking / ReadWorkspaceFile
                 / ListMemory / ReadMemoryFile / DeleteMemoryFile / DeleteMemoryBlock
                 / ListMcp / AddMcpServer / RemoveMcpServer / ListSkills / Ping
                 / GetSessionCost / GetStats / OpenDataDir / TestModel
  server→client: SessionCreated / SessionResumed / SessionList / RunStarted / TokenDelta
                 / ReasoningDelta / ToolCallStarted / ToolCallResult / Notice / PermissionRequest
                 / RunFinished(含 duration_ms + usage/cost_usd) / Error / ModelSet / Settings
                 / WorkspaceFile / MemoryList / MemoryFileContent / McpList / SkillList / Pong
                 / SessionCost / Stats / ModelTestResult
模型与 API Key 经 SetModel 持久化到 data_dir/settings.json，优先于 my-harness.toml 的 [agent]。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

PERMISSION_MODES = ("default", "acceptEdits", "plan", "dontAsk", "bypass")
THINKING_LEVELS = ("off", "low", "high", "max")

from ..config import Config, load_config
from ..context.compactor import ContextEngine
from ..core.events import EventStore, EventType
from ..core.session import Session
from ..loop.react import SYSTEM_TEMPLATE, Budget, ReActLoop
from ..memory.blocks import BlockStore
from ..memory.procedural import load_agent_md
from ..memory.tools import build_memory_tools
from ..memory.vault import MemoryVault
from ..observability.cost import cost_of, session_costs
from ..security.permissions import PermissionEngine
from ..tools.base import ToolContext, ToolRegistry
from ..tools.builtin import build_default_registry
from ..tools.skills import SkillRegistry, build_skill_tools
from ..tools.mcp_client import connect_all


def _settings_path(data_dir: Path) -> Path:
    return Path(data_dir) / "settings.json"


def load_settings(data_dir: Path) -> dict[str, Any]:
    p = _settings_path(data_dir)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_settings(data_dir: Path, settings: dict[str, Any]) -> None:
    p = _settings_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def _open_dir(path: Path) -> None:
    """用系统文件管理器打开目录（数据目录入口）。"""
    if sys.platform == "win32":
        os.startfile(str(path))  # noqa: S606
    elif sys.platform == "darwin":
        import subprocess

        subprocess.Popen(["open", str(path)])
    else:
        import subprocess

        subprocess.Popen(["xdg-open", str(path)])


class ClientConnection:
    """单个 WS 客户端：发送经队列串行化（回调线程安全）；持有挂起的审批 future。"""

    def __init__(self, send_json: Callable[[dict], Any]):
        self._send_json = send_json
        self._queue: asyncio.Queue = asyncio.Queue()
        self.pending: dict[str, asyncio.Future] = {}

    def notify(self, event: dict) -> None:
        self._queue.put_nowait(event)

    async def pump(self) -> None:
        while True:
            event = await self._queue.get()
            await self._send_json(event)

    async def ask(self, tool_desc: str, reason: str) -> str:
        rid = uuid.uuid4().hex[:12]
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.notify({"type": "PermissionRequest", "request_id": rid, "tool": tool_desc, "reason": reason})
        try:
            return await fut
        finally:
            self.pending.pop(rid, None)


class ServerState:
    def __init__(self, cfg: Config, provider_factory=None, registry: ToolRegistry | None = None):
        import platform

        self.cfg = cfg
        self.provider_factory = provider_factory or self._default_provider_factory
        self.registry = registry or build_default_registry()
        self.store = EventStore(cfg.data_dir)
        self.client: ClientConnection | None = None
        self.sessions: dict[str, tuple[Session, ReActLoop]] = {}
        self.running: dict[str, asyncio.Task] = {}
        self.mcp_conns: list = []
        self.settings = load_settings(cfg.data_dir)  # {model?, api_key?, api_base?, models?} 优先于 toml
        # 迁移：顶层 model 有值但列表为空 → 合成条目（models 列表 = 所有已保存配置，仅一个 active）
        if self.settings.get("model") and not any(
            m.get("model") == self.settings["model"] for m in self.settings.get("models", [])
        ):
            self.settings.setdefault("models", []).append(
                {
                    "model": self.settings["model"],
                    "api_key": self.settings.get("api_key", ""),
                    "api_base": self.settings.get("api_base", ""),
                }
            )

        # 记忆 / Skills / AGENT.md —— 与 CLI 同一套装配（parity）
        self.vault = MemoryVault(cfg.data_dir, Path(cfg.workspace))
        for t in build_memory_tools(self.vault):
            self.registry.register(t)
        self.skills = SkillRegistry(
            [Path(cfg.data_dir) / "skills", Path(cfg.workspace) / ".my-harness" / "skills"]
            if cfg.skills_enabled
            else []
        )
        self.skills.load()
        for t in build_skill_tools(self.skills):
            self.registry.register(t)
        system = SYSTEM_TEMPLATE.format(
            workspace=Path(cfg.workspace).resolve(), platform=platform.platform()
        )
        agent_md = load_agent_md(Path(cfg.workspace), cfg.data_dir)
        if agent_md:
            system += "\n\n" + agent_md
        if self.skills.summary():
            system += "\n\n" + self.skills.summary()
        self.system = system

    def _default_provider_factory(self):
        from ..providers import make_provider

        s = self.settings
        return make_provider(
            self.cfg.backend,
            s.get("model") or self.cfg.model,
            api_key=s.get("api_key") or None,
            api_base=s.get("api_base") or None,
            thinking=s.get("thinking") or None,
        )

    def _loop_cls(self):
        if self.cfg.loop_backend == "langgraph":
            from ..loop.langgraph_loop import LangGraphLoop

            return LangGraphLoop
        from ..loop.react import ReActLoop

        return ReActLoop

    def _notify(self, event: dict) -> None:
        if self.client:
            self.client.notify(event)

    async def handle(self, msg: dict) -> None:
        try:
            await self._dispatch(msg)
        except Exception as e:
            self._notify({"type": "Error", "error": f"{type(e).__name__}: {e}"})

    async def _dispatch(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "Ping":
            self._notify({"type": "Pong"})
        elif t == "CreateSession":
            await self._create_session(msg)
        elif t == "ResumeSession":
            await self._resume_session(msg)
        elif t == "SetPermissionMode":
            mode = msg.get("mode")
            if mode not in PERMISSION_MODES:
                raise ValueError(f"invalid permission mode: {mode}")
            self.settings["permission_mode"] = mode
            save_settings(self.cfg.data_dir, self.settings)
            for _, loop in self.sessions.values():
                loop.permissions.mode = mode
            self._notify({"type": "Notice", "text": f"权限模式 → {mode}"})
            self._notify(self._settings_payload())
        elif t == "SetThinking":
            level = msg.get("level")
            if level not in THINKING_LEVELS:
                raise ValueError(f"invalid thinking level: {level}")
            self.settings["thinking"] = level
            save_settings(self.cfg.data_dir, self.settings)
            for _, loop in self.sessions.values():
                if hasattr(loop.provider, "thinking"):
                    loop.provider.thinking = level
            self._notify({"type": "Notice", "text": f"思考档位 → {level}"})
            self._notify(self._settings_payload())
        elif t == "ReadWorkspaceFile":
            self._read_workspace_file(msg)
        elif t == "UploadImage":
            self._upload_image(msg)
        elif t == "RenameSession":
            title = (msg.get("title") or "").strip()
            self.store.set_session_meta(msg.get("session_id", ""), title=title or None)
            self._session_list()
        elif t == "PinSession":
            self.store.set_session_meta(msg.get("session_id", ""), pinned=bool(msg.get("pinned")))
            self._session_list()
        elif t == "DeleteSession":
            sid = msg.get("session_id", "")
            task = self.running.pop(sid, None)
            if task:
                task.cancel()
            self.sessions.pop(sid, None)
            self.store.delete_session(sid)
            self._notify({"type": "Notice", "text": f"会话 {sid[:8]} 已删除"})
            self._session_list()
        elif t == "CreateSessionGroup":
            name = (msg.get("name") or "").strip()
            if not name:
                raise ValueError("group name is required")
            groups = self.settings.setdefault("session_groups", [])
            if name not in groups:
                groups.append(name)
                save_settings(self.cfg.data_dir, self.settings)
            self._session_list()
        elif t == "RenameSessionGroup":
            old = (msg.get("name") or "").strip()
            new = (msg.get("new_name") or "").strip()
            if not old or not new:
                raise ValueError("name and new_name are required")
            groups = self.settings.setdefault("session_groups", [])
            if new in groups:
                raise ValueError(f"group '{new}' already exists")
            self.settings["session_groups"] = [new if g == old else g for g in groups]
            save_settings(self.cfg.data_dir, self.settings)
            self.store.rename_group(old, new)
            self._session_list()
        elif t == "DeleteSessionGroup":
            name = (msg.get("name") or "").strip()
            self.settings["session_groups"] = [
                g for g in self.settings.setdefault("session_groups", []) if g != name
            ]
            save_settings(self.cfg.data_dir, self.settings)
            self.store.clear_group(name)  # 组内会话变为未分组，不删会话
            self._notify({"type": "Notice", "text": f"分组 '{name}' 已删除（组内会话移至未分组）"})
            self._session_list()
        elif t == "SetSessionGroup":
            sid = msg.get("session_id", "")
            group = (msg.get("group") or "").strip() or None
            if group and group not in self.settings.setdefault("session_groups", []):
                raise ValueError(f"group '{group}' does not exist")
            self.store.set_session_meta(sid, group=group)
            self._session_list()
        elif t == "SearchContent":
            q = (msg.get("query") or "").strip()
            titles = {r["session_id"]: r["title"] for r in self.store.list_sessions()}
            results = [
                {**r, "title": titles.get(r["session_id"], "")}
                for r in self.store.search(q, limit=int(msg.get("limit", 20)))
            ]
            self._notify({"type": "ContentSearchResult", "query": q, "results": results})
        elif t == "ExportSession":
            sid = msg.get("session_id", "")
            pair = self.sessions.get(sid)
            sess = pair[0] if pair else Session(self.store, sid)
            md = sess.export_markdown()
            out_dir = Path(self.cfg.data_dir) / "exports"
            out_dir.mkdir(parents=True, exist_ok=True)
            out = out_dir / f"{sid[:12]}_{int(time.time())}.md"
            out.write_text(md, encoding="utf-8")
            self._notify({"type": "Notice", "text": f"会话已导出 → {out}"})
            self._notify({"type": "SessionExported", "session_id": sid, "path": str(out)})
        elif t == "ListSessions":
            self._session_list()
        elif t == "GetSessionCost":
            sid = msg.get("session_id", "")
            rows = session_costs(self.store, pricing=self.cfg.pricing)
            row = next((r for r in rows if r["session_id"] == sid), None)
            self._notify(
                {
                    "type": "SessionCost",
                    "session_id": sid,
                    "turns": row["turns"] if row else 0,
                    "input_tokens": row["input_tokens"] if row else 0,
                    "output_tokens": row["output_tokens"] if row else 0,
                    "cost_usd": row["cost_usd"] if row else None,
                }
            )
        elif t == "GetStats":
            total = None
            for r in session_costs(self.store, pricing=self.cfg.pricing):
                if r["cost_usd"] is not None:
                    total = (total or 0.0) + r["cost_usd"]
            self._notify(
                {
                    "type": "Stats",
                    **self.store.stats(),
                    "cost_usd": total,
                    "data_dir": str(self.cfg.data_dir),
                }
            )
        elif t == "OpenDataDir":
            _open_dir(self.cfg.data_dir)
            self._notify({"type": "Notice", "text": f"已打开数据目录 {self.cfg.data_dir}"})
        elif t == "TestModel":
            await self._test_model(msg)
        elif t == "ListMemory":
            self._memory_list(msg.get("session_id", ""))
        elif t == "ReadMemoryFile":
            self._notify(
                {"type": "MemoryFileContent", "path": msg["path"], "content": self.vault.read(msg["path"])}
            )
        elif t == "DeleteMemoryFile":
            self.vault.delete(msg["path"])
            self._notify({"type": "Notice", "text": f"已删除 memory:{msg['path']}"})
            self._memory_list(msg.get("session_id", ""))
        elif t == "DeleteMemoryBlock":
            pair = self.sessions.get(msg.get("session_id", ""))
            if pair and pair[1].ctx.blocks:
                pair[1].ctx.blocks.delete(msg.get("label", ""))
            self._memory_list(msg.get("session_id", ""))
        elif t == "ListMcp":
            self._notify({"type": "McpList", "servers": self._mcp_status()})
        elif t == "AddMcpServer":
            await self._add_mcp(msg)
        elif t == "RemoveMcpServer":
            await self._remove_mcp(msg)
        elif t == "ListSkills":
            self._notify(
                {
                    "type": "SkillList",
                    "skills": [
                        {"name": s.name, "description": s.description, "source": str(s.path)}
                        for s in self.skills.all()
                    ],
                }
            )
        elif t == "SetModel":
            self._set_model(msg)
        elif t == "GetSettings":
            self._notify(self._settings_payload())
        elif t == "SwitchModel":
            self._switch_model(msg)
        elif t == "DeleteModelConfig":
            self._delete_model_config(msg)
        elif t == "SendMessage":
            self._send_message(msg)
        elif t == "CancelRun":
            task = self.running.get(msg.get("session_id", ""))
            if task:
                task.cancel()
                self._notify({"type": "Notice", "text": "cancel requested"})
            else:
                self._notify({"type": "Notice", "text": "no run in progress"})
        elif t == "RespondPermission":
            fut = (self.client.pending if self.client else {}).get(msg.get("request_id", ""))
            if fut and not fut.done():
                fut.set_result(msg.get("answer", "no"))
        else:
            self._notify({"type": "Error", "error": f"unknown message type: {t}"})

    async def _create_session(self, msg: dict) -> None:
        await self._register_session(Session(self.store), created=True)

    async def _resume_session(self, msg: dict) -> None:
        sid = msg.get("session_id", "")
        if sid in self.sessions:
            self._notify({"type": "SessionResumed", "session_id": sid, "mode": self.sessions[sid][1].permissions.mode})
            self._notify(self._history_payload(self.sessions[sid][0]))
            return
        await self._register_session(Session(self.store, sid), created=False)
        self._notify(self._history_payload(self.sessions[sid][0]))

    def _history_payload(self, sess: Session) -> dict[str, Any]:
        """把会话的事件流回放为界面可渲染的历史条目（打开应用即恢复上次对话）。"""
        items: list[dict[str, Any]] = []
        for m in sess.messages():
            if m.role == "user":
                item: dict[str, Any] = {"kind": "user", "text": m.text()}
                imgs = [
                    {"media_type": b.media_type, "data": b.data}
                    for b in m.blocks
                    if getattr(b, "type", "") == "image"
                ]
                if imgs:
                    item["images"] = imgs
                items.append(item)
            elif m.role == "assistant":
                for b in m.blocks:
                    if hasattr(b, "input"):
                        items.append({"kind": "tool", "tool": b.name, "args": b.input})
                if m.text():
                    items.append({"kind": "assistant", "text": m.text()})
            elif m.role == "tool":
                continue  # 工具结果卡片在回放中省略，保持历史紧凑
        return {"type": "History", "session_id": sess.id, "items": items}

    async def _register_session(self, sess: Session, created: bool) -> None:
        if created:  # 让 list_sessions 能看到零事件的新会话
            self.store.append(sess.id, EventType.SESSION_STARTED, {"workspace": str(self.cfg.workspace)})
        ctx = ToolContext(
            workspace_root=Path(self.cfg.workspace).resolve(),
            data_dir=self.cfg.data_dir,
            vault=self.vault,
            skills=self.skills,
        )
        perms = PermissionEngine(
            mode=self.settings.get("permission_mode") or self.cfg.permissions_mode,
            allow=self.cfg.allow_rules,
            deny=self.cfg.deny_rules,
            ask=self.cfg.ask_rules,
            asker=self.client.ask if self.client else None,
        )
        engine = ContextEngine(
            summarizer=self.provider_factory(),
            context_window=self.cfg.context_window,
            clear_trigger=self.cfg.clear_trigger,
            data_dir=self.cfg.data_dir,
        )
        loop = self._loop_cls()(
            provider=self.provider_factory(),
            registry=self.registry,
            ctx=ctx,
            system=self.system,
            permissions=perms,
            context_engine=engine,
        )
        ctx.session_id = sess.id
        from ..memory.blocks import BlockStore

        ctx.blocks = BlockStore.for_session(self.cfg.data_dir, sess.id)
        from ..orchestrator.subagent import build_subagent_tool

        loop.registry.register(build_subagent_tool(loop, self.store))
        self.sessions[sess.id] = (sess, loop)
        event = "SessionCreated" if created else "SessionResumed"
        self._notify({"type": event, "session_id": sess.id, "mode": perms.mode})

    def _session_list(self) -> None:
        self._notify(
            {
                "type": "SessionList",
                "sessions": self.store.list_sessions()[:200],
                "groups": self.settings.get("session_groups", []),
            }
        )

    def _settings_payload(self) -> dict[str, Any]:
        from .. import __version__

        s = self.settings
        return {
            "type": "Settings",
            "model": s.get("model") or self.cfg.model,
            "has_api_key": bool(s.get("api_key")),
            "api_base": s.get("api_base", ""),
            "server_version": __version__,
            "permission_mode": s.get("permission_mode", self.cfg.permissions_mode),
            "thinking": s.get("thinking", "off"),
            "models": [
                {
                    "model": m.get("model", ""),
                    "has_key": bool(m.get("api_key")),
                    "api_base": m.get("api_base", ""),
                    "active": m.get("model") == s.get("model"),
                }
                for m in s.get("models", [])
            ],
        }

    def _activate_entry(self, entry: dict[str, Any]) -> None:
        """把某个已保存配置设为当前生效（顶层镜像 + 已开会话即时应用）。"""
        self.settings["model"] = entry["model"]
        self.settings["api_key"] = entry.get("api_key", "")
        self.settings["api_base"] = entry.get("api_base", "")
        for _, loop in self.sessions.values():
            p = loop.provider
            if hasattr(p, "default_model"):
                p.default_model = entry["model"]
                p.api_key = entry.get("api_key") or None
                p.api_base = entry.get("api_base") or None
    def _set_model(self, msg: dict) -> None:
        """保存并激活：按 model 串 upsert 到列表，且仅此一个生效。"""
        model = (msg.get("model") or "").strip()
        if not model:
            self._notify({"type": "Error", "error": "model is required"})
            return
        api_base = (msg.get("api_base") or "").strip()
        entries = self.settings.setdefault("models", [])
        entry = next((m for m in entries if m.get("model") == model), None)
        if entry is None:
            entry = {"model": model, "api_key": "", "api_base": api_base}
            entries.append(entry)
        submitted_key = (msg.get("api_key") or "").strip()
        if submitted_key:
            entry["api_key"] = submitted_key
        entry["api_base"] = api_base
        self._activate_entry(entry)
        save_settings(self.cfg.data_dir, self.settings)
        self._notify(
            {
                "type": "ModelSet",
                "model": model,
                "has_api_key": bool(entry.get("api_key")),
                "models": self._settings_payload()["models"],
            }
        )

    def _switch_model(self, msg: dict) -> None:
        model = (msg.get("model") or "").strip()
        entry = next((m for m in self.settings.get("models", []) if m.get("model") == model), None)
        if entry is None:
            raise ValueError(f"model config '{model}' not found")
        self._activate_entry(entry)
        save_settings(self.cfg.data_dir, self.settings)
        self._notify(self._settings_payload())

    def _delete_model_config(self, msg: dict) -> None:
        model = (msg.get("model") or "").strip()
        entries = self.settings.get("models", [])
        remaining = [m for m in entries if m.get("model") != model]
        if len(remaining) == len(entries):
            raise ValueError(f"model config '{model}' not found")
        self.settings["models"] = remaining
        if self.settings.get("model") == model:
            if remaining:
                self._activate_entry(remaining[0])
            else:  # 全部删光：回退到 toml 默认
                self.settings.pop("model", None)
                self.settings.pop("api_key", None)
                self.settings.pop("api_base", None)
                for _, loop in self.sessions.values():
                    p = loop.provider
                    if hasattr(p, "default_model"):
                        p.default_model = self.cfg.model
                        p.api_key = None
                        p.api_base = None
        save_settings(self.cfg.data_dir, self.settings)
        self._notify(self._settings_payload())

    # —— 记忆管理 / MCP / 技能（设置页面板） ——
    def _effective_mcp(self) -> dict:
        merged = dict(self.cfg.mcp_servers)
        merged.update(self.settings.get("mcp_servers", {}))
        return merged

    def _upload_image(self, msg: dict) -> None:
        """粘贴的图片落盘到工作区 attachments/，并以 base64 回传（发送时作为多模态块）。"""
        import base64
        import re

        data_url = msg.get("data_url", "")
        m = re.match(r"data:(image/(?:png|jpeg|gif|webp));base64,(.+)", data_url)
        if not m:
            raise ValueError("only image/png|jpeg|gif|webp data URLs are supported")
        media_type, b64 = m.group(1), m.group(2)
        raw = base64.b64decode(b64)
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("image too large (>10MB)")
        root = Path(self.cfg.workspace).resolve()
        ext = media_type.split("/")[1].replace("jpeg", "jpg")
        target_dir = root / "attachments"
        target_dir.mkdir(exist_ok=True)
        target = target_dir / f"paste_{int(time.time() * 1000)}.{ext}"
        target.write_bytes(raw)
        self._notify(
            {
                "type": "ImageSaved",
                "path": target.relative_to(root).as_posix(),
                "media_type": media_type,
                "data": b64,
                "bytes": len(raw),
            }
        )

    def _read_workspace_file(self, msg: dict) -> None:
        """读取工作区内文件（附件场景），路径安全限制 + 50K 字符上限。"""
        root = Path(self.cfg.workspace).resolve()
        p = Path(msg.get("path", "")).expanduser()
        if not p.is_absolute():
            p = root / p
        p = p.resolve()
        if not p.is_relative_to(root):
            raise ValueError(f"path '{msg.get('path')}' escapes the workspace")
        if not p.is_file():
            raise FileNotFoundError(f"{p} does not exist")
        content = p.read_text(encoding="utf-8", errors="replace")
        truncated = len(content) > 50_000
        if truncated:
            content = content[:50_000]
        rel = p.relative_to(root).as_posix()
        self._notify(
            {"type": "WorkspaceFile", "path": rel, "content": content, "truncated": truncated}
        )

    def _memory_list(self, session_id: str) -> None:
        blocks = []
        pair = self.sessions.get(session_id)
        block_store = pair[1].ctx.blocks if pair else None
        if block_store:
            for b in block_store.all():
                blocks.append(
                    {"label": b.label, "chars": len(b.value), "limit": b.limit_chars, "value": b.value[:800]}
                )
        files = [
            {"path": p.relative_to(self.vault.root).as_posix(), "size": p.stat().st_size}
            for p in sorted(self.vault.root.rglob("*"))
            if p.is_file()
        ]
        self._notify({"type": "MemoryList", "blocks": blocks, "files": files})

    async def _test_model(self, msg: dict) -> None:
        """连通性测试：用待验证的配置发一次最小请求（不落库、不影响当前生效配置）。

        api_key 留空时沿用该模型已保存配置里的 key；强制 thinking=off 保证测试快速返回。
        """
        from ..core.messages import Message, TextBlock
        from ..providers import make_provider

        model = (msg.get("model") or self.settings.get("model") or self.cfg.model).strip()
        api_base = (msg.get("api_base") or "").strip()
        api_key = (msg.get("api_key") or "").strip()
        if not api_key:
            entry = next((m for m in self.settings.get("models", []) if m.get("model") == model), None)
            api_key = (entry or {}).get("api_key") or self.settings.get("api_key") or ""
        t0 = time.monotonic()
        try:
            provider = make_provider(
                self.cfg.backend,
                model,
                api_key=api_key or None,
                api_base=api_base or None,
                thinking="off",
            )
            result = await asyncio.wait_for(
                provider.chat(
                    system="You are a connectivity health check. Reply with exactly: pong",
                    messages=[Message(role="user", blocks=[TextBlock(text="ping")])],
                    tools=[],
                ),
                timeout=30,
            )
            self._notify(
                {
                    "type": "ModelTestResult",
                    "ok": True,
                    "model": model,
                    "latency_ms": int((time.monotonic() - t0) * 1000),
                    "reply": (result.text or "").strip()[:80],
                }
            )
        except Exception as e:
            self._notify(
                {
                    "type": "ModelTestResult",
                    "ok": False,
                    "model": model,
                    "latency_ms": int((time.monotonic() - t0) * 1000),
                    "error": f"{type(e).__name__}: {e}"[:300],
                }
            )

    def _mcp_status(self) -> list[dict[str, Any]]:
        conns = {c.name: c for c in self.mcp_conns}
        out = []
        for name, scfg in self._effective_mcp().items():
            conn = conns.get(name)
            tools = sum(
                1 for t in self.registry.specs() if t["function"]["name"].startswith(f"mcp__{name}__")
            )
            if conn and conn.session:
                status = "已连接"
            elif conn and conn.error:
                status = f"失败: {conn.error}"
            else:
                status = "未连接"
            out.append(
                {
                    "name": name,
                    "transport": "http" if scfg.get("url") else "stdio",
                    "target": scfg.get("url")
                    or (scfg.get("command", "") + " " + " ".join(scfg.get("args", []))).strip(),
                    "source": "settings" if name in self.settings.get("mcp_servers", {}) else "toml",
                    "status": status,
                    "tools": tools,
                }
            )
        return out

    async def _connect_one(self, name: str, scfg: dict) -> int:
        from ..tools.mcp_client import MCPConnection, collect_tools

        conn = MCPConnection(
            name,
            command=scfg.get("command"),
            args=scfg.get("args") or [],
            env=scfg.get("env"),
            url=scfg.get("url"),
        )
        await conn.start()
        self.mcp_conns = [c for c in self.mcp_conns if c.name != name] + [conn]
        tools = await collect_tools(conn)
        for t in tools:
            self.registry.register(t)
        return len(tools)

    async def _add_mcp(self, msg: dict) -> None:
        import re

        name = (msg.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError("server name 只能含字母/数字/下划线/连字符")
        if msg.get("transport") == "http":
            if not (msg.get("url") or "").strip():
                raise ValueError("url is required for http transport")
            scfg = {"url": msg["url"].strip()}
        else:
            if not (msg.get("command") or "").strip():
                raise ValueError("command is required for stdio transport")
            scfg = {"command": msg["command"].strip(), "args": (msg.get("args") or "").split()}
        n = await self._connect_one(name, scfg)  # 先连接，失败则不保存
        servers = dict(self.settings.get("mcp_servers", {}))
        servers[name] = scfg
        self.settings["mcp_servers"] = servers
        save_settings(self.cfg.data_dir, self.settings)
        self._notify({"type": "Notice", "text": f"MCP '{name}' 已连接，注册 {n} 个工具"})
        self._notify({"type": "McpList", "servers": self._mcp_status()})

    async def _remove_mcp(self, msg: dict) -> None:
        name = msg.get("name", "")
        conn = next((c for c in self.mcp_conns if c.name == name), None)
        if conn:
            await conn.close()
            self.mcp_conns.remove(conn)
        removed = self.registry.remove_prefix(f"mcp__{name}__")
        servers = dict(self.settings.get("mcp_servers", {}))
        if name in servers:
            del servers[name]
            self.settings["mcp_servers"] = servers
            save_settings(self.cfg.data_dir, self.settings)
        self._notify(
            {
                "type": "Notice",
                "text": f"MCP '{name}' 已移除（{removed} 个工具）。注意：来自 my-harness.toml 的 server 重启后会重新加载。",
            }
        )
        self._notify({"type": "McpList", "servers": self._mcp_status()})

    def _send_message(self, msg: dict) -> None:
        sid = msg.get("session_id", "")
        pair = self.sessions.get(sid)
        if pair is None:
            self._notify({"type": "Error", "error": f"unknown session: {sid}"})
            return
        if sid in self.running:
            self._notify({"type": "Error", "error": "a run is already in progress for this session"})
            return
        sess, loop = pair
        images = msg.get("images") or []  # [{media_type, data}]
        self.running[sid] = asyncio.create_task(self._run(sess, loop, msg.get("text", ""), images))

    async def _run(self, sess: Session, loop, text: str, images: list[dict] | None = None) -> None:
        sid = sess.id
        t0 = time.monotonic()
        budget = Budget()
        self._notify({"type": "RunStarted", "session_id": sid})
        try:
            answer = await loop.run(
                sess,
                text,
                images=images,
                budget=budget,
                on_delta=lambda d: self._notify({"type": "TokenDelta", "session_id": sid, "text": d}),
                on_reason=lambda r: self._notify({"type": "ReasoningDelta", "session_id": sid, "text": r}),
                on_tool=lambda tu: self._notify(
                    {"type": "ToolCallStarted", "session_id": sid, "tool": tu.name, "args": tu.input}
                ),
                on_tool_result=lambda tu, tr: self._notify(
                    {
                        "type": "ToolCallResult",
                        "session_id": sid,
                        "tool": tu.name,
                        "is_error": tr.is_error,
                        "chars": len(tr.content),
                    }
                ),
                on_notice=lambda n: self._notify({"type": "Notice", "session_id": sid, "text": n}),
            )
            usage = {"input_tokens": budget.usage.input_tokens, "output_tokens": budget.usage.output_tokens}
            model = getattr(loop.provider, "default_model", "")  # 空（测试桩）→ cost None，不猜测
            self._notify(
                {
                    "type": "RunFinished",
                    "session_id": sid,
                    "answer": answer,
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                    "usage": usage,
                    "cost_usd": cost_of(model, usage, self.cfg.pricing),
                }
            )
        except asyncio.CancelledError:
            self._notify({"type": "Notice", "session_id": sid, "text": "run cancelled"})
        except Exception as e:
            self._notify({"type": "Error", "session_id": sid, "error": f"{type(e).__name__}: {e}"})
        finally:
            self.running.pop(sid, None)


def create_app(
    cfg: Config | None = None, provider_factory=None, registry: ToolRegistry | None = None
) -> FastAPI:
    cfg = cfg or load_config()
    state = ServerState(cfg, provider_factory=provider_factory, registry=registry)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        mcp_cfg = state._effective_mcp()
        if mcp_cfg:
            tools, conns, warnings = await connect_all(mcp_cfg)
            for w in warnings:
                print(f"[mcp] {w}")
            for t in tools:
                state.registry.register(t)
            state.mcp_conns = conns
        yield
        for c in state.mcp_conns:
            await c.close()

    app = FastAPI(title="my-harness", lifespan=lifespan)

    from .. import __version__

    @app.get("/health")
    def health():
        # version 用于桌面端版本握手：不匹配的旧 daemon 会被自动替换
        return {
            "status": "ok",
            "version": __version__,
            "sessions": len(state.sessions),
            "tools": len(state.registry.specs()),
        }

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):
        await websocket.accept()
        client = ClientConnection(websocket.send_json)
        state.client = client
        pump = asyncio.create_task(client.pump())
        try:
            while True:
                msg = await websocket.receive_json()
                await state.handle(msg)
        except WebSocketDisconnect:
            pass
        finally:
            for fut in client.pending.values():
                if not fut.done():
                    fut.set_result("no")
            pump.cancel()
            for task in list(state.running.values()):
                task.cancel()
            state.client = None
            state.running.clear()

    return app
