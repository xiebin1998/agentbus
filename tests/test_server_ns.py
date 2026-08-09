"""TASK-02: ns 接入与内存治理 —— SSE 身份/消息容量/离线过滤/断线清理测试。

覆盖范围（对应 TASKS.md TASK-02 / 架构 3.1、11.8 缺陷 1/2/4/5/7）：
- normalize_ns: SSE ns 参数归一化
- session_key: 会话键（flat 兼容 / ns 键）
- store_message / sweep_messages: _messages 上限与 TTL
- filter_offline: 群发部分送达（11.8 缺陷 7）
- resolve_agent_key: get_agent_info 的键解析
- health: ns 维度汇总
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


# ---------- normalize_ns ----------

class TestNormalizeNs:
    def test_none_stays_none(self):
        assert server.normalize_ns(None) is None

    def test_empty_string_is_none(self):
        assert server.normalize_ns("") is None

    def test_value_trimmed(self):
        assert server.normalize_ns(" iot ") == "iot"


# ---------- session_key ----------

class TestSessionKey:
    def test_flat_key_when_ns_none(self):
        """兼容：未传 ns 的连接沿用旧键（client_id 本体）"""
        assert server.session_key("demo", None) == "demo"

    def test_ns_key_when_ns_present(self):
        assert server.session_key("demo", "iot") == "iot/demo"

    def test_explicit_default_ns_key(self):
        assert server.session_key("demo", "default") == "default/demo"


# ---------- store_message / sweep_messages ----------

class TestMessageStore:
    def test_store_keeps_payload(self):
        store = {}
        server.store_message(store, "m1", {"from": "a", "to": "b"})
        assert store["m1"]["from"] == "a"

    def test_cap_evicts_oldest(self):
        store = {}
        for i in range(5):
            server.store_message(store, f"m{i}", {"i": i}, max_len=3)
        assert list(store.keys()) == ["m2", "m3", "m4"]

    def test_sweep_removes_expired_only(self):
        store = {}
        now = datetime.now(timezone.utc)
        server.store_message(store, "old", {"x": 1})
        server.store_message(store, "new", {"x": 2})
        store["old"]["_stored_at"] = now - timedelta(hours=25)
        removed = server.sweep_messages(store, now, ttl_seconds=24 * 3600)
        assert removed == 1
        assert "new" in store and "old" not in store

    def test_sweep_keeps_everything_within_ttl(self):
        store = {}
        server.store_message(store, "m1", {"x": 1})
        assert server.sweep_messages(store, datetime.now(timezone.utc)) == 0


# ---------- filter_offline ----------

class TestFilterOffline:
    def test_all_online(self):
        online, offline = server.filter_offline(["a", "b"], {"a", "b"})
        assert online == ["a", "b"] and offline == []

    def test_partial_offline(self):
        online, offline = server.filter_offline(["a", "b", "c"], {"a", "c"})
        assert online == ["a", "c"] and offline == ["b"]


# ---------- resolve_agent_key ----------

class TestResolveAgentKey:
    def test_qualified_target_passthrough(self):
        assert server.resolve_agent_key("iot/be-svc", None) == "iot/be-svc"

    def test_plain_target_inherits_caller_ns(self):
        assert server.resolve_agent_key("be-svc", "iot") == "iot/be-svc"

    def test_plain_target_flat_caller(self):
        assert server.resolve_agent_key("be-svc", None) == "be-svc"


# ---------- health（ns 维度） ----------

class TestHealth:
    def test_health_reports_namespaces(self):
        saved_sessions, saved_info = server._sessions.copy(), server._agent_info.copy()
        server._sessions.clear()
        server._agent_info.clear()
        try:
            server._sessions["demo"] = object()
            server._sessions["iot/a"] = object()
            server._sessions["iot/b"] = object()
            resp = asyncio.run(server.health(None))
            body = json.loads(resp.body)
            assert body["status"] == "ok"
            assert body["namespaces"] == {"flat": 1, "iot": 2}
        finally:
            server._sessions.clear()
            server._sessions.update(saved_sessions)
            server._agent_info.update(saved_info)
