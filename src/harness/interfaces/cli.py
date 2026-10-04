"""CLI（M1）：chat 交互 REPL（流式 + 审批 + 压缩提示 + MCP）、run（含 --json headless）、sessions、serve。"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from ..config import PERMISSION_MODES, load_config
from ..context.compactor import ContextEngine
from ..core.events import EventStore
from ..core.session import Session
from ..evals.runner import load_cases, run_eval
from ..extension.hooks import HookManager
from ..loop.react import SYSTEM_TEMPLATE, Budget, ReActLoop
from ..memory.blocks import BlockStore
from ..memory.consolidator import MemoryConsolidator
from ..memory.procedural import load_agent_md
from ..memory.tools import build_memory_tools
from ..memory.vault import MemoryVault
from ..observability.cost import session_costs
from ..orchestrator.subagent import build_subagent_tool
from ..providers import make_provider
from ..persistence.shadow import ShadowCheckpoint
from ..security.permissions import PermissionEngine
from ..security.sandbox import DockerSandbox
from ..server.app import create_app
from ..tools.base import ToolContext, ToolRegistry
from ..tools.builtin import build_default_registry
from ..tools.skills import SkillRegistry, build_skill_tools

app = typer.Typer(help="My-Harness CLI (M1)")
console = Console()


def main() -> None:
    app()


def _notice(note: str) -> None:
    console.print(f"[magenta]⚡ {note}[/magenta]")


def _print_tool(tu) -> None:
    args = json.dumps(tu.input, ensure_ascii=False)
    console.print(f"[dim]→ {tu.name}({args[:120]})[/dim]")


def _print_tool_result(tu, tr) -> None:
    if tr.is_error:
        console.print(f"[red]  ✗ {tu.name}: {tr.content[:160]}[/red]")
    else:
        console.print(f"[dim]  ✓ {tu.name} ({len(tr.content)} chars)[/dim]")


def _build(cfg, workspace: Path):
    import platform

    ctx = ToolContext(workspace_root=workspace.resolve(), data_dir=cfg.data_dir)
    store = EventStore(cfg.data_dir)
    ctx.event_store = store
    ctx.vault = MemoryVault(cfg.data_dir, workspace)

    provider = make_provider(cfg.backend, cfg.model)
    engine = ContextEngine(
        summarizer=make_provider(cfg.backend, cfg.summarizer_model or cfg.model),
        context_window=cfg.context_window,
        clear_trigger=cfg.clear_trigger,
        data_dir=cfg.data_dir,
    )

    registry = build_default_registry(
        sandbox=DockerSandbox(image=cfg.sandbox_image) if cfg.sandbox_type == "docker" else None
    )
    for t in build_memory_tools(ctx.vault):
        registry.register(t)

    # Skills（L1 渐进披露：仅 summary 进 system，正文经 load_skill 按需载入）
    skills = SkillRegistry(
        [Path(cfg.data_dir) / "skills", workspace / ".my-harness" / "skills"]
        if cfg.skills_enabled
        else []
    )
    skills.load()
    ctx.skills = skills
    for t in build_skill_tools(skills):
        registry.register(t)

    # 程序性记忆 + skills 摘要拼进静态 system 前缀
    system = SYSTEM_TEMPLATE.format(workspace=ctx.workspace_root, platform=platform.platform())
    agent_md = load_agent_md(workspace, cfg.data_dir)
    if agent_md:
        system += "\n\n" + agent_md
    if skills.summary():
        system += "\n\n" + skills.summary()

    async def _asker(tool_desc: str, reason: str) -> str:
        console.print(f"[yellow]⚠ approval needed:[/yellow] {tool_desc}")
        console.print(f"[yellow]  ({reason})[/yellow]")
        ans = console.input("[yellow]  [y] once / [a] always / [n] deny › [/yellow]").strip().lower()
        return {"y": "yes", "a": "always"}.get(ans, "no")

    perms = PermissionEngine(
        mode=cfg.permissions_mode,
        allow=cfg.allow_rules,
        deny=cfg.deny_rules,
        ask=cfg.ask_rules,
        asker=_asker,
    )
    hooks = HookManager(cfg.hooks) if cfg.hooks else None
    shadow = ShadowCheckpoint(cfg.data_dir, workspace)
    loop_cls = _loop_cls(cfg.loop_backend)
    loop = loop_cls(
        provider=provider,
        registry=registry,
        ctx=ctx,
        system=system,
        permissions=perms,
        context_engine=engine,
        hooks=hooks,
        shadow=shadow,
    )
    consolidator = (
        MemoryConsolidator(make_provider(cfg.backend, cfg.summarizer_model or cfg.model), ctx.vault)
        if cfg.memory_consolidate
        else None
    )
    loop.registry.register(build_subagent_tool(loop, store))  # M3：父代理可派生子代理
    return ctx, store, provider, loop, perms, shadow, consolidator


def _loop_cls(loop_backend: str):
    if loop_backend == "langgraph":
        from ..loop.langgraph_loop import LangGraphLoop

        return LangGraphLoop
    from ..loop.react import ReActLoop

    return ReActLoop


def _bind_session(ctx: ToolContext, sess: Session) -> None:
    """短期记忆 blocks 按会话绑定；/new 切换会话时同步更新。"""
    from ..core.events import EventType

    ctx.session_id = sess.id
    ctx.blocks = BlockStore.for_session(ctx.data_dir, sess.id)
    if not sess.store.list_events(sess.id):
        sess.store.append(sess.id, EventType.SESSION_STARTED, {"source": "cli"})


async def _load_mcp(cfg, registry: ToolRegistry) -> list:
    """连接配置中的 MCP server，注册其工具；单个失败只告警。返回连接以便退出时关闭。"""
    if not cfg.mcp_servers:
        return []
    from ..tools.mcp_client import connect_all

    tools, conns, warnings = await connect_all(cfg.mcp_servers)
    for w in warnings:
        console.print(f"[yellow]⚠ {w}[/yellow]")
    for t in tools:
        registry.register(t)
    if tools:
        console.print(f"[dim]MCP: {len(tools)} tool(s) from {len(conns)} server(s)[/dim]")
    return conns


async def _chat(cfg, session_id: str | None, workspace: Path) -> None:
    ctx, store, provider, loop, perms, shadow, consolidator = _build(cfg, workspace)
    conns = await _load_mcp(cfg, loop.registry)
    mem_tasks: list = []
    try:
        sess = Session(store, session_id)
        _bind_session(ctx, sess)
        console.print(
            f"[bold]My-Harness[/bold] session [cyan]{sess.id}[/cyan]  "
            f"model [cyan]{provider.default_model}[/cyan]  perms [cyan]{perms.mode}[/cyan]"
        )
        console.print(f"workspace {ctx.workspace_root}   (/exit /new /sessions /model <m> /mode <m> /rollback [id])")

        while True:
            try:
                line = console.input("[bold cyan]you › [/bold cyan]").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not line:
                continue
            if line.startswith("/"):
                cmd, _, arg = line.partition(" ")
                if cmd in ("/exit", "/quit"):
                    break
                elif cmd == "/new":
                    sess = Session(store)
                    _bind_session(ctx, sess)
                    console.print(f"[green]new session {sess.id}[/green]")
                elif cmd == "/memory":
                    blocks = ctx.blocks.all() if ctx.blocks else []
                    console.print(
                        f"[dim]blocks: {len(blocks)} · memory dir: {ctx.vault.root}[/dim]"
                    )
                    for b in blocks:
                        console.print(f"  · {b.label} ({len(b.value)}/{b.limit_chars} chars)")
                elif cmd == "/sessions":
                    _print_sessions(store)
                elif cmd == "/model":
                    if arg.strip():
                        provider.default_model = arg.strip()
                        console.print(f"[green]model → {provider.default_model}[/green]")
                    else:
                        console.print(provider.default_model)
                elif cmd == "/mode":
                    if arg.strip() in PERMISSION_MODES:
                        perms.mode = arg.strip()
                        console.print(f"[green]permission mode → {perms.mode}[/green]")
                    else:
                        console.print(f"mode: {perms.mode}  ({'/'.join(PERMISSION_MODES)})")
                elif cmd == "/rollback":
                    cps = shadow.list()
                    target = arg.strip() or (cps[0]["id"] if cps else "")
                    if not target:
                        console.print("[yellow]no checkpoints yet[/yellow]")
                    else:
                        res = shadow.restore(target)
                        console.print(
                            f"[green]restored {res['id']}[/green] "
                            f"(restored: {res['restored'] or '-'}, removed: {res['removed'] or '-'})"
                        )
                else:
                    console.print(f"[yellow]unknown command {cmd}[/yellow]")
                continue

            console.print("[bold green]agent ›[/bold green] ", end="")
            try:
                await loop.run(
                    sess,
                    line,
                    budget=Budget(),
                    on_delta=lambda d: (sys.stdout.write(d), sys.stdout.flush()),
                    on_tool=_print_tool,
                    on_tool_result=_print_tool_result,
                    on_notice=_notice,
                )
                console.print()
                if consolidator:  # 后台事实整合（不阻塞下一轮输入）
                    mem_tasks.append(asyncio.create_task(consolidator.consolidate(sess)))
            except KeyboardInterrupt:
                console.print("\n[yellow]run interrupted (session kept)[/yellow]")
            except Exception as e:
                console.print(f"\n[red]error: {type(e).__name__}: {e}[/red]")
    finally:
        if mem_tasks:  # 给后台整合一点时间，超时取消
            done, pending = await asyncio.wait(mem_tasks, timeout=15)
            for t in pending:
                t.cancel()
            for t in done:
                note = t.result() if not t.exception() else None
                if note:
                    _notice(note)
        for c in conns:
            await c.close()


def _print_sessions(store: EventStore) -> None:
    table = Table(title="Sessions")
    table.add_column("session")
    table.add_column("events")
    table.add_column("last_active")
    for s in store.list_sessions():
        table.add_row(s["session_id"][:16], str(s["events"]), s["last_active"])
    console.print(table)


@app.command()
def chat(
    model: str = typer.Option(None, help="覆盖模型（LiteLLM 格式）"),
    session: str = typer.Option(None, help="恢复指定会话"),
    workspace: Path = typer.Option(Path("."), help="工作区根目录"),
    mode: str = typer.Option(None, help=f"权限模式：{'/'.join(PERMISSION_MODES)}"),
) -> None:
    """交互式对话（流式 + 权限审批 + 自动压缩 + MCP）。"""
    cfg = load_config()
    if model:
        cfg.model = model
    if mode:
        cfg.permissions_mode = mode
    asyncio.run(_chat(cfg, session, workspace))


@app.command()
def run(
    task: str,
    model: str = typer.Option(None),
    workspace: Path = typer.Option(Path(".")),
    mode: str = typer.Option(None, help=f"权限模式：{'/'.join(PERMISSION_MODES)}"),
    json_out: bool = typer.Option(False, "--json", help="headless：以 JSONL 事件流输出，供脚本/程序消费"),
) -> None:
    """一次性任务：执行后打印最终答案与会话 ID；--json 进入可编程 headless 模式。"""
    cfg = load_config()
    if model:
        cfg.model = model
    if mode:
        cfg.permissions_mode = mode
    asyncio.run(_run_once(cfg, task, workspace, json_out=json_out))


async def _run_once(cfg, task: str, workspace: Path, json_out: bool = False) -> None:
    ctx, store, provider, loop, perms, shadow, consolidator = _build(cfg, workspace)
    conns = await _load_mcp(cfg, loop.registry)

    def _emit(obj: dict) -> None:
        print(json.dumps(obj, ensure_ascii=False), flush=True)

    budget = Budget()
    t0 = time.monotonic()
    try:
        sess = Session(store)
        _bind_session(ctx, sess)
        if json_out:
            _emit(
                {
                    "type": "run_started",
                    "session_id": sess.id,
                    "model": provider.default_model,
                    "perms": perms.mode,
                }
            )
            answer = await loop.run(
                sess,
                task,
                budget=budget,
                on_delta=lambda d: _emit({"type": "token", "text": d}),
                on_tool=lambda tu: _emit({"type": "tool_call", "tool": tu.name, "args": tu.input}),
                on_tool_result=lambda tu, tr: _emit(
                    {"type": "tool_result", "tool": tu.name, "is_error": tr.is_error, "chars": len(tr.content)}
                ),
                on_notice=lambda n: _emit({"type": "notice", "text": n}),
            )
            _emit(
                {
                    "type": "done",
                    "session_id": sess.id,
                    "model": provider.default_model,
                    "answer": answer,
                    "usage": budget.usage.model_dump(),
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                    "resume": f"harness chat --session {sess.id}",
                }
            )
            return
        console.print(
            f"[dim]session {sess.id} · model {provider.default_model} · perms {perms.mode}[/dim]"
        )
        answer = await loop.run(
            sess,
            task,
            budget=budget,
            on_delta=lambda d: (sys.stdout.write(d), sys.stdout.flush()),
            on_tool=_print_tool,
            on_tool_result=_print_tool_result,
            on_notice=_notice,
        )
        console.print(
            f"\n[bold green]answer[/bold green] {answer}\n"
            f"[dim]resume: harness chat --session {sess.id}[/dim]"
        )
        if consolidator:
            try:
                note = await consolidator.consolidate(sess)
                if note:
                    _notice(note)
            except Exception as e:
                console.print(f"[yellow]consolidation failed: {type(e).__name__}: {e}[/yellow]")
    except Exception as e:
        if json_out:
            _emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
            raise typer.Exit(code=1) from e
        raise
    finally:
        for c in conns:
            await c.close()


@app.command()
def export(
    session_id: str,
    out: Path = typer.Option(None, help="输出文件路径，缺省为当前目录下 <会话ID>.md"),
) -> None:
    """导出会话为 Markdown 转写。"""
    from ..core.session import Session

    cfg = load_config()
    sess = Session(EventStore(cfg.data_dir), session_id)
    path = out or Path(f"{session_id[:12]}.md")
    path.write_text(sess.export_markdown(), encoding="utf-8")
    console.print(f"[green]exported → {path.resolve()}[/green]")


@app.command()
def sessions() -> None:
    """列出历史会话。"""
    store = EventStore(load_config().data_dir)
    _print_sessions(store)


@app.command()
def cost(
    model: str = typer.Option(None, help="计价模型，缺省用配置的 model"),
) -> None:
    """按会话汇总 token 用量与近似费用（[pricing] 可覆盖价格表）。"""
    cfg = load_config()
    rows = session_costs(EventStore(cfg.data_dir), model or cfg.model, cfg.pricing)
    if not rows:
        console.print("[yellow]no runs recorded yet[/yellow]")
        return
    table = Table(title="Cost / session")
    for col in ("session", "turns", "input tok", "output tok", "cost (USD)"):
        table.add_column(col)
    for r in rows:
        table.add_row(
            r["session_id"][:16],
            str(r["turns"]),
            f"{r['input_tokens']:,}",
            f"{r['output_tokens']:,}",
            f"{r['cost_usd']:.4f}" if r["cost_usd"] is not None else "n/a",
        )
    console.print(table)


@app.command("eval")
def evaluate(
    path: Path = typer.Argument(..., help="评测用例目录（*.json）或单文件"),
    trials: int = typer.Option(1, help="每用例运行次数（>1 可统计 pass@k / pass^k）"),
    max_turns: int = typer.Option(15),
    workspace: Path = typer.Option(Path(".")),
    model: str = typer.Option(None),
) -> None:
    """跑评测集：Task/Trial/Grader，输出 pass@1 与 pass^k。"""
    cfg = load_config()
    if model:
        cfg.model = model
    cases = load_cases(path)
    if not cases:
        console.print(f"[red]no eval cases found in {path}[/red]")
        raise typer.Exit(1)
    provider = LiteLLMProvider(cfg.model)
    console.print(f"[dim]running {len(cases)} case(s) × {trials} trial(s) · model {cfg.model}[/dim]")

    async def _go():
        return await run_eval(
            cases,
            provider,
            workspace_root=workspace.resolve() / ".evals",
            data_dir=cfg.data_dir,
            trials=trials,
            max_turns=max_turns,
        )

    report = asyncio.run(_go())
    table = Table(title="Eval results")
    for col in ("case", "passes/trials", "grader"):
        table.add_column(col)
    for r in report["cases"]:
        table.add_row(r["name"], f"{r['passes']}/{r['trials']}", r["grader"])
    console.print(table)
    console.print(
        f"[bold]pass@1[/bold] = {report['pass@1']:.2%}   [bold]pass^k[/bold] = {report['pass^k']:.2%}"
    )
    import time as _time

    out = cfg.data_dir / "evals" / f"report_{int(_time.time())}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(f"[dim]report saved: {out}[/dim]")


@app.command()
def serve(
    port: int = typer.Option(8765, help="监听端口"),
    workspace: Path = typer.Option(Path("."), help="工作区根目录"),
    mode: str = typer.Option(None, help=f"权限模式：{'/'.join(PERMISSION_MODES)}"),
) -> None:
    """启动本地 daemon：WebSocket 协议（DESIGN.md §4.11），桌面端将复用同一协议。"""
    import uvicorn

    cfg = load_config()
    cfg.workspace = workspace
    if mode:
        cfg.permissions_mode = mode
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
