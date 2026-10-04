"""成本核算（DESIGN.md §4.9）：从 RUN_FINISHED 事件聚合每会话 token/费用。

价格表为 USD/1M tokens 的近似公开价（M4 默认值），可用 my-harness.toml 的 [pricing] 覆盖：
    [pricing]
    "openai/gpt-4o-mini" = [0.15, 0.60]
未知模型 cost 显示为空，不猜测。
"""

from __future__ import annotations

from typing import Any

# model -> (input USD/MTok, output USD/MTok)
DEFAULT_PRICING: dict[str, tuple[float, float]] = {
    "openai/gpt-4o-mini": (0.15, 0.60),
    "openai/gpt-4o": (2.50, 10.00),
    "anthropic/claude-sonnet-4-20250514": (3.00, 15.00),
    "deepseek/deepseek-chat": (0.27, 1.10),
    "zhipuai/glm-4-plus": (7.00, 7.00),
}


def cost_of(model: str, usage: dict[str, Any], pricing: dict[str, list[float]] | None = None) -> float | None:
    if not usage or not model:
        return None
    table = {k: tuple(v) for k, v in (pricing or {}).items()} or {}
    pin, pout = table.get(model) or DEFAULT_PRICING.get(model) or (None, None)
    if pin is None:
        return None
    return usage.get("input_tokens", 0) / 1e6 * pin + usage.get("output_tokens", 0) / 1e6 * pout


def session_costs(store, model: str = "", pricing: dict[str, list[float]] | None = None) -> list[dict[str, Any]]:
    """按会话聚合 RUN_FINISHED 里的 usage（CLI cost / 桌面端成本显示的数据源）。

    计价按事件里记录的模型（RUN_FINISHED.model）逐条进行，同一会话中途切换模型也能分开算；
    老事件没有 model 字段时回退到调用方传入的 model。价格未知的条目不计入（不猜测），
    整个会话没有任何已知价格时 cost_usd 为 None。
    """
    totals: dict[str, dict[str, Any]] = {}
    for e in store.search_all("run_finished"):
        sid = e["session_id"]
        t = totals.setdefault(
            sid, {"turns": 0, "input_tokens": 0, "output_tokens": 0, "last_active": "", "cost_usd": None}
        )
        t["turns"] += 1
        t["last_active"] = e["ts"]
        u = e.get("usage") or {}
        t["input_tokens"] += u.get("input_tokens", 0)
        t["output_tokens"] += u.get("output_tokens", 0)
        m = e.get("model") or model
        c = cost_of(m, u, pricing) if m else None
        if c is not None:
            t["cost_usd"] = (t["cost_usd"] or 0.0) + c
    out = [{"session_id": sid, **t} for sid, t in totals.items()]
    out.sort(key=lambda x: x["last_active"], reverse=True)
    return out
