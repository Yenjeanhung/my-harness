"""配置加载：my-harness.toml（见 my-harness.toml.example），缺省全部可用。"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "openai/gpt-4o-mini"

PERMISSION_MODES = ("default", "acceptEdits", "plan", "dontAsk", "bypass")


def default_data_dir() -> Path:
    return Path.home() / ".my-harness"


@dataclass
class Config:
    model: str = DEFAULT_MODEL
    workspace: Path = field(default_factory=lambda: Path("."))
    data_dir: Path = field(default_factory=default_data_dir)
    # 模型后端（langchain=默认 | litellm）与循环引擎（react=默认 | langgraph）
    backend: str = "langchain"
    loop_backend: str = "react"
    # permissions
    permissions_mode: str = "default"
    allow_rules: list[str] = field(default_factory=list)
    deny_rules: list[str] = field(default_factory=list)
    ask_rules: list[str] = field(default_factory=list)
    # context engine
    context_window: int = 128_000
    clear_trigger: int = 30_000
    summarizer_model: str = ""
    # mcp: name -> {command, args, env}（stdio）或 {url}（streamable http）
    mcp_servers: dict[str, dict[str, Any]] = field(default_factory=dict)
    # hooks: 事件名 -> shell 命令列表（pre_tool_use / post_tool_use）
    hooks: dict[str, list[str]] = field(default_factory=dict)
    # memory / skills（M2）
    memory_consolidate: bool = True
    skills_enabled: bool = True
    # sandbox（M3）：local（权限闸+shadow 兜底）或 docker（bash 进容器）
    sandbox_type: str = "local"
    sandbox_image: str = "python:3.12-slim"
    # pricing（M4）：model -> [input, output] USD/1M tokens，覆盖内置近似价
    pricing: dict[str, list[float]] = field(default_factory=dict)


def load_config(path: Path | None = None) -> Config:
    p = path or Path("my-harness.toml")
    data: dict = tomllib.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    agent = data.get("agent", {})
    perms = data.get("permissions", {})
    ctxs = data.get("context", {})
    return Config(
        model=agent.get("model", DEFAULT_MODEL),
        workspace=Path(agent.get("workspace", ".")).expanduser(),
        data_dir=Path(data.get("data", {}).get("dir", default_data_dir())).expanduser(),
        backend=agent.get("backend", "langchain"),
        loop_backend=agent.get("loop_backend", "react"),
        permissions_mode=perms.get("mode", "default"),
        allow_rules=list(perms.get("allow", [])),
        deny_rules=list(perms.get("deny", [])),
        ask_rules=list(perms.get("ask", [])),
        context_window=int(ctxs.get("context_window", 128_000)),
        clear_trigger=int(ctxs.get("clear_trigger", 30_000)),
        summarizer_model=ctxs.get("summarizer_model", ""),
        mcp_servers=dict(data.get("mcp_servers", {})),
        hooks={k: list(v) for k, v in data.get("hooks", {}).items()},
        memory_consolidate=bool(data.get("memory", {}).get("consolidate", True)),
        skills_enabled=bool(data.get("skills", {}).get("enabled", True)),
        sandbox_type=data.get("sandbox", {}).get("type", "local"),
        sandbox_image=data.get("sandbox", {}).get("image", "python:3.12-slim"),
        pricing={k: [float(x) for x in v] for k, v in data.get("pricing", {}).items()},
    )
