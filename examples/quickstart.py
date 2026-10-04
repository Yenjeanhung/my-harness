"""程序化使用示例：不经过 CLI，直接用 SDK 跑一个任务。

先配置好 API key（如 OPENAI_API_KEY），然后：
    .venv/Scripts/python examples/quickstart.py
"""

import asyncio
from pathlib import Path

from harness.config import load_config
from harness.core.events import EventStore
from harness.core.session import Session
from harness.loop.react import ReActLoop
from harness.providers.litellm_provider import LiteLLMProvider
from harness.tools.base import ToolContext
from harness.tools.builtin import build_default_registry


async def main() -> None:
    cfg = load_config()
    ctx = ToolContext(workspace_root=Path(".").resolve(), data_dir=cfg.data_dir)
    session = Session(EventStore(cfg.data_dir))
    loop = ReActLoop(
        provider=LiteLLMProvider(cfg.model),
        registry=build_default_registry(),
        ctx=ctx,
    )
    answer = await loop.run(
        session,
        "列出当前目录结构，并用一句话总结这个项目是做什么的",
        on_delta=lambda d: print(d, end="", flush=True),
    )
    print(f"\n\n[session: {session.id}] answer: {answer}")


if __name__ == "__main__":
    asyncio.run(main())
