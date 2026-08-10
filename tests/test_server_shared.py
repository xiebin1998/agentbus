"""TASK-24: 共享 MQTT 连接扩容（架构 11.8 演进方案 2）

hub 仅一条 MQTT 连接，通配订阅 flat + ns 两条 message topic 与 metric topic，
按 topic 解析目标身份路由到对应 AgentSession；取消每 Agent 的 paho 客户端与线程。
本文件覆盖：topic 路由纯函数、send_message 走共享连接、就绪门控走共享 ready。
"""

import asyncio
import threading
from types import SimpleNamespace

import pytest

import server


# ─── parse_message_topic：message topic → (ns_or_None, client_id) ────────────

def test_parse_message_topic_flat():
    assert server.parse_message_topic("/phnix/ai/channel/qwenpaw/message") == (None, "qwenpaw")


def test_parse_message_topic_ns():
    assert server.parse_message_topic("/phnix/ai/channel/team-a/dev-1/message") == ("team-a", "dev-1")


def test_parse_message_topic_invalid():
    assert server.parse_message_topic("/phnix/ai/channel/message") is None          # 缺身份段
    assert server.parse_message_topic("/phnix/ai/channel/a/b/c/message") is None    # 超段
    assert server.parse_message_topic("/phnix/ai/channel//message") is None         # 空身份
    assert server.parse_message_topic("/phnix/ai/metric/a") is None                 # 非 message topic
    assert server.parse_message_topic("") is None


def test_route_message_key_flat_and_ns():
    assert server.route_message_key("/phnix/ai/channel/qwenpaw/message") == "qwenpaw"
    assert server.route_message_key("/phnix/ai/channel/team-a/dev-1/message") == "team-a/dev-1"
    assert server.route_message_key("/other/topic") is None


# ─── 会话资源模型：AgentSession 不再自建 MQTT 客户端/线程 ───────────────────

def make_session(loop):
    return server.AgentSession("shared-t", loop, "loadns")


def test_agent_session_has_no_own_mqtt_client():
    s = make_session(asyncio.new_event_loop())
    assert not hasattr(s, "mqtt"), "共享连接模型下会话不得自建 paho 客户端"


def test_send_message_publishes_via_shared_client(monkeypatch):
    """send_message 统一走共享连接发布（记录 topic/qos）"""
    calls = []

    def fake_publish(topic, payload, qos=0):
        calls.append({"topic": topic, "payload": payload, "qos": qos})
        return SimpleNamespace(rc=0)

    monkeypatch.setattr(server, "_shared_client", SimpleNamespace(publish=fake_publish))
    loop = asyncio.new_event_loop()
    s = make_session(loop)
    result = s.send_message("hello", "other")
    assert result["status"] == "sent"
    assert len(calls) == 1
    assert calls[0]["topic"] == "/phnix/ai/channel/loadns/other/message"
    assert calls[0]["qos"] == 2
    assert '"hello"' in calls[0]["payload"]


def test_send_message_without_shared_client_reports_error(monkeypatch):
    """共享连接未启动时不得静默成功"""
    monkeypatch.setattr(server, "_shared_client", None)
    s = make_session(asyncio.new_event_loop())
    with pytest.raises(RuntimeError):
        s.send_message("hello", "other")


def test_wait_ready_follows_shared_ready(monkeypatch):
    """会话就绪门控跟随共享连接订阅就绪（TASK-13 门控语义不变）"""
    ev = threading.Event()
    monkeypatch.setattr(server, "_shared_ready", ev)
    s = make_session(asyncio.new_event_loop())
    assert s.wait_ready(0.05) is False
    ev.set()
    assert s.wait_ready(0.05) is True


def test_publish_shared_delegates_to_client(monkeypatch):
    calls = []
    client = SimpleNamespace(
        publish=lambda topic, payload, qos=0: calls.append((topic, payload, qos)) or SimpleNamespace(rc=0),
    )
    monkeypatch.setattr(server, "_shared_client", client)
    server.publish_shared("/phnix/ai/channel/x/message", "{}", qos=1)
    assert calls == [("/phnix/ai/channel/x/message", "{}", 1)]


def test_publish_shared_without_client_returns_false(monkeypatch):
    monkeypatch.setattr(server, "_shared_client", None)
    assert server.publish_shared("/t", "{}") is False


# ─── TASK-25：共享连接 TLS CA（自签证书场景） ──────────────────────────────

class _FakeMqttClient:
    def __init__(self, client_id=None, protocol=None, callback_api_version=None):
        self.tls_ca = "NOT_CALLED"

    def username_pw_set(self, u, p):
        pass

    def tls_set(self, ca_certs=None):
        self.tls_ca = ca_certs

    def connect_async(self, *a, **kw):
        pass

    def loop_start(self):
        pass


def test_start_shared_client_tls_uses_ca_certs(monkeypatch):
    created = []
    monkeypatch.setattr(server, "MQTT_USE_TLS", True)
    monkeypatch.setattr(server, "MQTT_CA_CERTS", "/certs/ca.crt")
    monkeypatch.setattr(server, "_shared_client", None)
    monkeypatch.setattr(
        server.mqtt, "Client",
        lambda **kw: created.append(_FakeMqttClient(**kw)) or created[-1],
    )
    server.start_shared_client()
    assert created[0].tls_ca == "/certs/ca.crt"


def test_start_shared_client_tls_without_ca(monkeypatch):
    created = []
    monkeypatch.setattr(server, "MQTT_USE_TLS", True)
    monkeypatch.setattr(server, "MQTT_CA_CERTS", "")
    monkeypatch.setattr(server, "_shared_client", None)
    monkeypatch.setattr(
        server.mqtt, "Client",
        lambda **kw: created.append(_FakeMqttClient(**kw)) or created[-1],
    )
    server.start_shared_client()
    assert created[0].tls_ca is None  # 未配 CA → 信任系统证书链


# ─── TASK-29：出站身份独立无互踢（架构 5.5-B 身份红线，PLAN T25 验收） ─────

@pytest.fixture
def clean_sessions():
    """快照/恢复模块级路由表，防跨用例污染"""
    saved_sessions = dict(server._sessions)
    saved_info = dict(server._agent_info)
    yield
    server._sessions.clear()
    server._sessions.update(saved_sessions)
    server._agent_info.clear()
    server._agent_info.update(saved_info)


def test_independent_client_ids_do_not_evict_each_other(clean_sessions, monkeypatch):
    """hermes 出站独立身份（<项目>-hermes）：一方下线不得影响另一方（架构 5.5-B）"""
    loop = asyncio.new_event_loop()
    proj = server.AgentSession("fe-dev", loop, "iot")
    hermes = server.AgentSession("fe-dev-hermes", loop, "iot")
    proj.start()
    hermes.start()
    assert "iot/fe-dev" in server._sessions
    assert "iot/fe-dev-hermes" in server._sessions

    # hermes 侧 SSE 断线的 finally 清理：仅移除自身键
    hermes.close()
    assert "iot/fe-dev-hermes" not in server._sessions
    assert "iot/fe-dev" in server._sessions  # 项目会话不受牵连

    # 会话侧无自有连接可关：close 不得触碰共享客户端（互踢的物理根源已消除）
    sentinel = object()
    monkeypatch.setattr(server, "_shared_client", sentinel)
    proj.close()
    assert server._shared_client is sentinel
    loop.close()
