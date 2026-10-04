"""事件溯源：会话内一切皆事件，append-only；SQLite 供查询，JSONL 供人读镜像（DESIGN.md §4.7）。"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel


class EventType(str, Enum):
    SESSION_STARTED = "session_started"
    RUN_STARTED = "run_started"
    RUN_FINISHED = "run_finished"
    USER_MESSAGE = "user_message"
    ASSISTANT_MESSAGE = "assistant_message"
    TOOL_RESULTS = "tool_results"
    COMPACTION = "compaction"
    PERMISSION_DECISION = "permission_decision"
    SUBAGENT_SPAWNED = "subagent_spawned"
    ERROR = "error"


class Event(BaseModel):
    id: str
    session_id: str
    seq: int
    ts: str
    type: EventType
    payload: dict[str, Any]


def _message_search_text(payload: dict[str, Any]) -> str:
    """提取消息中可搜索的纯文本（只取 text 块，避免搜到 JSON 键名产生假阳性）。"""
    parts = []
    for b in payload.get("blocks", []):
        if isinstance(b, dict) and b.get("type") == "text":
            t = str(b.get("text", "")).strip()
            if t:
                parts.append(t[:4000])
    return " ".join(parts)


class EventStore:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = Path(data_dir) if data_dir else Path.home() / ".my-harness"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir = self.data_dir / "sessions"
        self.sessions_dir.mkdir(exist_ok=True)
        # 跨线程使用（CLI 进程内直连 / TestClient portal 线程 / server），访问均经事件循环串行化
        self._db = sqlite3.connect(self.data_dir / "harness.db", check_same_thread=False)
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)"
        )
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS session_meta (
                session_id TEXT PRIMARY KEY,
                title TEXT,
                pinned INTEGER DEFAULT 0
            )
            """
        )
        try:  # 手动分组：老库平滑迁移
            self._db.execute("ALTER TABLE session_meta ADD COLUMN group_name TEXT")
            self._db.commit()
        except Exception:
            pass  # 列已存在
        try:  # 预计算搜索列（ZCode 同款）：写入时维护，查询免扫 JSON
            self._db.execute("ALTER TABLE session_meta ADD COLUMN searchable_text TEXT")
            self._db.commit()
        except Exception:
            pass  # 列已存在
        self._backfill_searchable()
        self._db.commit()

    def set_session_meta(
        self, session_id: str, title: str | None = None, pinned: bool | None = None, group: Any = "__unset__"
    ) -> dict[str, Any]:
        """更新会话元数据（重命名/置顶/手动分组）；None 表示清空，__unset__ 表示保持不变。"""
        row = self._db.execute(
            "SELECT title, pinned, group_name, searchable_text FROM session_meta WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        cur_title = row[0] if row else None
        cur_pinned = bool(row[1]) if row else False
        cur_group = row[2] if row else None
        cur_search = row[3] if row else None
        if title is not None:
            cur_title = title
        if pinned is not None:
            cur_pinned = pinned
        if group != "__unset__":
            cur_group = group or None
        self._db.execute(
            "INSERT OR REPLACE INTO session_meta (session_id, title, pinned, group_name, searchable_text) "
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, cur_title, int(cur_pinned), cur_group, cur_search),
        )
        self._db.commit()
        return {"title": cur_title, "pinned": cur_pinned, "group": cur_group}

    def rename_group(self, old: str, new: str) -> None:
        self._db.execute("UPDATE session_meta SET group_name = ? WHERE group_name = ?", (new, old))
        self._db.commit()

    def clear_group(self, name: str) -> None:
        self._db.execute("UPDATE session_meta SET group_name = NULL WHERE group_name = ?", (name,))
        self._db.commit()

    def delete_session(self, session_id: str) -> None:
        """删除整个会话：事件行 + 元数据 + JSONL 文件。"""
        self._db.execute("DELETE FROM events WHERE session_id = ?", (session_id,))
        self._db.execute("DELETE FROM session_meta WHERE session_id = ?", (session_id,))
        self._db.commit()
        f = self.sessions_dir / f"{session_id}.jsonl"
        if f.exists():
            f.unlink()

    def append(self, session_id: str, type: EventType, payload: dict[str, Any]) -> Event:
        row = self._db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?", (session_id,)
        ).fetchone()
        event = Event(
            id=uuid.uuid4().hex,
            session_id=session_id,
            seq=row[0] + 1,
            ts=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            type=type,
            payload=payload,
        )
        self._db.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)",
            (
                event.id,
                session_id,
                event.seq,
                event.ts,
                type.value,
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        # 预计算搜索列：对话正文写入时拼好（ZCode 同款），搜索时不再扫 JSON
        if type in (EventType.USER_MESSAGE, EventType.ASSISTANT_MESSAGE):
            text = _message_search_text(payload)
            if text:
                self._db.execute(
                    "INSERT INTO session_meta (session_id, searchable_text) VALUES (?, ?) "
                    "ON CONFLICT(session_id) DO UPDATE SET "
                    "searchable_text = COALESCE(searchable_text, '') || ' ' || excluded.searchable_text",
                    (session_id, text),
                )
        self._db.commit()
        with open(self.sessions_dir / f"{session_id}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(event.model_dump(), ensure_ascii=False) + "\n")
        return event

    def list_events(self, session_id: str) -> list[Event]:
        rows = self._db.execute(
            "SELECT id, session_id, seq, ts, type, payload FROM events "
            "WHERE session_id = ? ORDER BY seq",
            (session_id,),
        ).fetchall()
        return [
            Event(
                id=r[0],
                session_id=r[1],
                seq=r[2],
                ts=r[3],
                type=EventType(r[4]),
                payload=json.loads(r[5]),
            )
            for r in rows
        ]

    def list_sessions(self) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT session_id, COUNT(*), MIN(ts), MAX(ts) FROM events "
            "GROUP BY session_id ORDER BY MAX(ts) DESC"
        ).fetchall()
        meta = {
            r[0]: (r[1], bool(r[2]), r[3])
            for r in self._db.execute("SELECT session_id, title, pinned, group_name FROM session_meta")
        }
        out = []
        for r in rows:
            custom_title, pinned, group_name = meta.get(r[0], (None, False, None))
            title = custom_title or ""
            first = self._db.execute(
                "SELECT payload FROM events WHERE session_id = ? AND type = 'user_message' "
                "ORDER BY seq LIMIT 1",
                (r[0],),
            ).fetchone()
            if not title and first:
                try:
                    payload = json.loads(first[0])
                    title = " ".join(
                        b.get("text", "")
                        for b in payload.get("blocks", [])
                        if isinstance(b, dict) and b.get("type") == "text"
                    ).strip()[:60]
                except Exception:
                    title = ""
            out.append(
                {
                    "session_id": r[0],
                    "events": r[1],
                    "started": r[2],
                    "last_active": r[3],
                    "title": title,
                    "pinned": pinned,
                    "group": group_name,
                }
            )
        out.sort(key=lambda x: not x["pinned"])  # 置顶优先（稳定排序保持组内最近在前）
        return out

    def search_all(self, event_type: str) -> list[dict[str, Any]]:
        """按类型取全部事件（payload 已解析，附 session_id/seq/ts）——成本聚合等用。"""
        rows = self._db.execute(
            "SELECT session_id, seq, ts, payload FROM events WHERE type = ? ORDER BY ts",
            (event_type,),
        ).fetchall()
        out = []
        for r in rows:
            payload = json.loads(r[3])
            payload.update({"session_id": r[0], "seq": r[1], "ts": r[2]})
            out.append(payload)
        return out

    def stats(self) -> dict[str, Any]:
        """本机数据统计（设置页「常规」面板）：会话/消息/运行计数与 token 用量。"""
        counts = dict(self._db.execute("SELECT type, COUNT(*) FROM events GROUP BY type").fetchall())
        n_sessions = self._db.execute("SELECT COUNT(DISTINCT session_id) FROM events").fetchone()[0]
        input_tokens = output_tokens = 0
        for e in self.search_all("run_finished"):
            u = e.get("usage") or {}
            input_tokens += u.get("input_tokens", 0)
            output_tokens += u.get("output_tokens", 0)
        db = self.data_dir / "harness.db"
        return {
            "sessions": n_sessions,
            "messages": counts.get("user_message", 0) + counts.get("assistant_message", 0),
            "runs": counts.get("run_finished", 0),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "db_bytes": db.stat().st_size if db.exists() else 0,
        }

    def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """跨会话内容检索：对预计算列 searchable_text 做 LIKE（ZCode 同款）。

        每个会话只返回首条命中的上下文 snippet；关键词中的 %/_ 会被转义为字面量。
        """
        q = query.strip()
        if not q:
            return []
        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self._db.execute(
            "SELECT m.session_id, m.searchable_text, MAX(e.rowid) AS last_rowid "
            "FROM session_meta m JOIN events e ON e.session_id = m.session_id "
            "WHERE m.searchable_text LIKE ? ESCAPE '\\' "
            "GROUP BY m.session_id ORDER BY last_rowid DESC LIMIT ?",
            (f"%{esc}%", limit),
        ).fetchall()
        out = []
        for sid, text, _ts in rows:
            text = text or ""
            idx = text.lower().find(q.lower())
            if idx < 0:
                out.append({"session_id": sid, "snippet": text[:160]})
                continue
            start = max(0, idx - 60)
            snippet = text[start : idx + len(q) + 80].strip()
            out.append({"session_id": sid, "snippet": ("…" + snippet) if start > 0 else snippet})
        return out

    def _backfill_searchable(self) -> None:
        """老库一次性回填：为没有 meta 行的旧会话从事件流构建 searchable_text。"""
        try:
            rows = self._db.execute(
                "SELECT session_id, payload FROM events "
                "WHERE type IN ('user_message','assistant_message') ORDER BY session_id, seq"
            ).fetchall()
        except Exception:
            return
        texts: dict[str, list[str]] = {}
        for sid, payload in rows:
            try:
                t = _message_search_text(json.loads(payload))
            except Exception:
                continue
            if t:
                texts.setdefault(sid, []).append(t)
        for sid, parts in texts.items():
            exists = self._db.execute(
                "SELECT 1 FROM session_meta WHERE session_id = ?", (sid,)
            ).fetchone()
            if exists:
                continue
            self._db.execute(
                "INSERT INTO session_meta (session_id, searchable_text) VALUES (?, ?)",
                (sid, " ".join(parts)[:200_000]),
            )
        self._db.commit()
