import asyncio
import json

import pytest

from harness.core.events import EventStore, EventType
from harness.core.session import Session
from harness.observability.cost import cost_of, session_costs


def test_session_costs_aggregate(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    store.append(
        sess.id, EventType.RUN_FINISHED,
        {"answer": "a", "turns": 2, "usage": {"input_tokens": 1_000_000, "output_tokens": 100_000}},
    )
    store.append(
        sess.id, EventType.RUN_FINISHED,
        {"answer": "b", "turns": 1, "usage": {"input_tokens": 500_000, "output_tokens": 50_000}},
    )
    rows = session_costs(store, model="openai/gpt-4o-mini")
    r = rows[0]
    assert r["input_tokens"] == 1_500_000 and r["output_tokens"] == 150_000 and r["turns"] == 2
    assert r["cost_usd"] == pytest.approx(1.5 * 0.15 + 0.15 * 0.60)


def test_unknown_model_no_guess():
    assert cost_of("mystery/model", {"input_tokens": 10, "output_tokens": 10}) is None


def test_pricing_override():
    p = cost_of(
        "mystery/model",
        {"input_tokens": 1_000_000, "output_tokens": 1_000_000},
        pricing={"mystery/model": [1.0, 2.0]},
    )
    assert p == pytest.approx(3.0)


def test_session_costs_per_event_model(tmp_path):
    """同一会话中途换模型：按事件记录的模型分开计价；老事件无 model 回退入参。"""
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    store.append(
        sess.id, EventType.RUN_FINISHED,
        {"answer": "a", "turns": 1, "model": "openai/gpt-4o",
         "usage": {"input_tokens": 1_000_000, "output_tokens": 1_000_000}},
    )
    store.append(
        sess.id, EventType.RUN_FINISHED,
        {"answer": "b", "turns": 1, "usage": {"input_tokens": 1_000_000, "output_tokens": 0}},
    )
    r = session_costs(store, model="openai/gpt-4o-mini")[0]
    assert r["cost_usd"] == pytest.approx(2.50 + 10.00 + 0.15)


def test_session_costs_unknown_model_none(tmp_path):
    store = EventStore(data_dir=tmp_path)
    sess = Session(store)
    store.append(
        sess.id, EventType.RUN_FINISHED,
        {"answer": "x", "turns": 1, "model": "mystery/m",
         "usage": {"input_tokens": 5, "output_tokens": 5}},
    )
    assert session_costs(store)[0]["cost_usd"] is None
