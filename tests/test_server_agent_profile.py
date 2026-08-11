"""TASK-32 Task 3/4：init 注册端点 + 指标占位行（顺序契约）+ send_message 离线拒发。

隔离环境：临时 SQLite + 假 dynsec + 不连真实 broker（同 test_server_console_v4）。
"""
import asyncio
import base64
import json
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient


@pytest.fixture()
def app_ctx(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTBUS_DB_PATH", str(tmp_path / "agentbus.db"))
    monkeypatch.setenv("AGENTBUS_ADMIN_USER", "root")
    monkeypatch.setenv("AGENTBUS_ADMIN_PASSWORD", "rootpw")
    monkeypatch.delenv("MCP_API_TOKEN", raising=False)

    class FakeDynsec:
        def __getattr__(self, name):
            def call(*a, **k):
                pass
            return call

    import server
    server.DYNSEC_CLIENT = FakeDynsec()
    server.init_hub_state()
    yield server
    # 关连接释放 WAL 文件锁，否则 Windows 上 tmp_path 目录无法清理被后续测试复用旧库
    if server.DB_CONN is not None:
        server.DB_CONN.close()
        server.DB_CONN = None
    server._metrics_store._data.clear()


@pytest.fixture()
def client(app_ctx):
    return TestClient(app_ctx.app)


def _basic(user, pw):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


def _reg_body(**kw):
    body = {"ns": "pay", "client_id": "ag-1", "name": "支付助手"}
    body.update(kw)
    return body


# ─── 注册端点鉴权 ─────────────────────────────────────────────────────────────


def test_register_requires_auth(client):
    assert client.post("/api/agent/register", json=_reg_body()).status_code == 401
    assert client.post("/api/agent/register", json=_reg_body(),
                       headers=_basic("alice", "wrong")).status_code == 401
    # 不存在的账号
    assert client.post("/api/agent/register", json=_reg_body(),
                       headers=_basic("ghost", "pw")).status_code == 401


def test_register_success_owner_is_auth_user(client, app_ctx):
    from hub import store, auth
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user")
    r = client.post("/api/agent/register",
                    json=_reg_body(description="处理支付", capabilities=["chat"],
                                   tools=["send_message"]),
                    headers=_basic("alice", "pw"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "registered"
    assert body["client_id"] == "ag-1"
    a = store.get_agent(app_ctx.DB_CONN, "pay", "ag-1")
    assert a["name"] == "支付助手"
    assert a["description"] == "处理支付"
    assert a["capabilities"] == ["chat"]
    assert a["tools"] == ["send_message"]
    assert a["owner"] == "alice"


def test_register_name_over_50_rejected(client, app_ctx):
    from hub import store, auth
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user")
    r = client.post("/api/agent/register", json=_reg_body(name="x" * 51),
                    headers=_basic("alice", "pw"))
    assert r.status_code == 400
    # name 必填
    r = client.post("/api/agent/register", json=_reg_body(name=""),
                    headers=_basic("alice", "pw"))
    assert r.status_code == 400


def test_register_idempotent_fill_only(client, app_ctx):
    """重跑只补空不覆盖：首写 name/description 不被二次注册改写，空 capabilities 被补齐"""
    from hub import store, auth
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user")
    client.post("/api/agent/register", json=_reg_body(description="首述"),
                headers=_basic("alice", "pw"))
    r = client.post("/api/agent/register",
                    json=_reg_body(name="改名", description="改述", capabilities=["vision"]),
                    headers=_basic("alice", "pw"))
    assert r.status_code == 200
    a = store.get_agent(app_ctx.DB_CONN, "pay", "ag-1")
    assert a["name"] == "支付助手"
    assert a["description"] == "首述"
    assert a["capabilities"] == ["vision"]
    assert a["owner"] == "alice"


def test_register_token_channel_owner_empty(client, app_ctx, monkeypatch):
    """MCP_API_TOKEN 已配置时亦接受 ?token=/Bearer；此通道 owner 留空"""
    monkeypatch.setenv("MCP_API_TOKEN", "sekret")
    r = client.post("/api/agent/register?token=sekret", json=_reg_body())
    assert r.status_code == 200, r.text
    from hub import store
    a = store.get_agent(app_ctx.DB_CONN, "pay", "ag-1")
    assert a["owner"] == ""
    # 错误 token 拒绝
    assert client.post("/api/agent/register?token=nope",
                       json=_reg_body(client_id="ag-2")).status_code == 401


# ─── 指标占位行（顺序契约） ────────────────────────────────────────────────────


class FakeMetricMsg:
    def __init__(self, topic, payload):
        import json
        self.topic = topic
        self.payload = json.dumps(payload).encode("utf-8")


def _metric(ns, cid, tools=None):
    p = {"type": "metric", "from": f"{ns}/{cid}", "metrics": {"injected_ok": 1},
         "timestamp": "2026-08-11T10:00:00+00:00"}
    if tools is not None:
        p["tools"] = tools
    return FakeMetricMsg(f"/agentbus/ai/metric/{ns}/{cid}", p)


def test_first_metric_creates_placeholder_before_store(app_ctx):
    """顺序契约：首条指标处理后 get_agent 必存在（'未注册+在线'不可观测）"""
    from hub import store
    app_ctx._handle_metric_message(_metric("pay", "ag-new"))
    a = store.get_agent(app_ctx.DB_CONN, "pay", "ag-new")
    assert a is not None
    assert a["name"] == "ag-new"          # 占位名=client_id
    assert a["owner"] == ""
    # 指标也已入库
    assert "pay/ag-new" in app_ctx._metrics_store.snapshot()


def test_placeholder_name_not_overwritten_by_metrics(app_ctx):
    """占位行建立后，后续指标不碰 name/description/capabilities/owner"""
    from hub import store, auth
    app_ctx._handle_metric_message(_metric("pay", "ag-x"))
    # 真身注册补齐档案
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user")
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-x", name="真名", owner="alice", fill=True)
    # 再来指标：name/owner 不被重置
    app_ctx._handle_metric_message(_metric("pay", "ag-x"))
    a = store.get_agent(app_ctx.DB_CONN, "pay", "ag-x")
    assert a["name"] == "真名"
    assert a["owner"] == "alice"


def test_metric_tools_refresh_existing_row_only(app_ctx):
    """已存在行仅刷新 tools（若指标带）；不带的指标不清空 tools"""
    from hub import store
    app_ctx._handle_metric_message(_metric("pay", "ag-t", tools=["t1"]))
    assert store.get_agent(app_ctx.DB_CONN, "pay", "ag-t")["tools"] == ["t1"]
    app_ctx._handle_metric_message(_metric("pay", "ag-t", tools=["t1", "t2"]))
    assert store.get_agent(app_ctx.DB_CONN, "pay", "ag-t")["tools"] == ["t1", "t2"]
    app_ctx._handle_metric_message(_metric("pay", "ag-t"))
    assert store.get_agent(app_ctx.DB_CONN, "pay", "ag-t")["tools"] == ["t1", "t2"]


def test_metric_without_db_does_not_crash(monkeypatch):
    """DB_CONN 未初始化（lifespan 未生效）时指标入库照常，占位逻辑跳过"""
    import server
    old = server.DB_CONN
    server.DB_CONN = None
    try:
        server._handle_metric_message(_metric("pay", "ag-nodb"))
        assert "pay/ag-nodb" in server._metrics_store.snapshot()
    finally:
        server.DB_CONN = old
        server._metrics_store._data.clear()


# ─── TASK-32 Task 4：_offline_targets 纯函数四分支 ───────────────────────


def test_offline_targets_all_online():
    import server
    now = datetime.now(timezone.utc)
    snap = {"ns/a": {"last_seen": now.isoformat()},
            "ns/b": {"last_seen": (now - timedelta(seconds=60)).isoformat()}}
    assert server._offline_targets(["ns/a", "ns/b"], snap, now) == []


def test_offline_targets_single_offline():
    import server
    now = datetime.now(timezone.utc)
    snap = {"ns/a": {"last_seen": (now - timedelta(seconds=120)).isoformat()}}
    assert server._offline_targets(["ns/a"], snap, now) == ["ns/a"]


def test_offline_targets_partial_multi():
    import server
    now = datetime.now(timezone.utc)
    snap = {"ns/a": {"last_seen": now.isoformat()},
            "ns/b": {"last_seen": (now - timedelta(seconds=91)).isoformat()}}
    # ns/c 无条目（未上报过）也视为离线；保序输出
    assert server._offline_targets(["ns/a", "ns/b", "ns/c"], snap, now) == ["ns/b", "ns/c"]


def test_offline_targets_empty():
    import server
    assert server._offline_targets([], {}, datetime.now(timezone.utc)) == []


# ─── TASK-32 Task 4：send_message 离线拒发（工具层） ─────────────────────


@pytest.fixture()
def mcp_env(monkeypatch):
    """隔离会话/指标全局态 + 假共享连接（记录 publish）+ 就绪事件已置位"""
    import server
    saved = (dict(server._sessions), dict(server._agent_info))
    server._sessions.clear()
    server._agent_info.clear()
    monkeypatch.setattr(server, "_metrics_store", server.MetricsStore())
    calls = []
    monkeypatch.setattr(server, "_shared_client",
                        SimpleNamespace(publish=lambda topic, payload, qos=0:
                                        calls.append(topic) or SimpleNamespace(rc=0)))
    ev = threading.Event()
    ev.set()
    monkeypatch.setattr(server, "_shared_ready", ev)
    yield calls
    server._sessions.clear(); server._sessions.update(saved[0])
    server._agent_info.clear(); server._agent_info.update(saved[1])


def _tool(mcp_env, name, arguments):
    """在 asyncio.run 内建会话并直达 call_tool handler（create_mcp_server 需运行中循环）"""
    import server
    from mcp import types

    async def run():
        srv = server.create_mcp_server("alice", "pay")
        server._sessions["pay/alice"].mcp_session = object()
        handler = srv.request_handlers[types.CallToolRequest]
        req = types.CallToolRequest(method="tools/call",
                                    params=types.CallToolRequestParams(name=name, arguments=arguments))
        result = await handler(req)
        return json.loads(result.root.content[0].text)

    return asyncio.run(run())


def test_send_message_rejects_offline_target_without_publish(mcp_env):
    """单目标离线 → 整体拒发，不投 broker，列明离线目标与重试指引"""
    import server
    server._metrics_store.update("pay/bob", {"injected_ok": 1},
                                 (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat())
    out = _tool(mcp_env, "send_message", {"text": "hi", "to": "bob"})
    assert "error" in out
    assert out["offline_targets"] == ["pay/bob"]
    assert "重试" in out["hint"] and "daemon" in out["hint"]
    assert mcp_env == []  # 未投 broker


def test_send_message_no_profile_target_has_placeholder_hint(mcp_env):
    """无档案目标（从未上报）：拒发且提示等占位或 agentbus init"""
    out = _tool(mcp_env, "send_message", {"text": "hi", "to": "ghost"})
    assert out["offline_targets"] == ["pay/ghost"]
    assert "未找到档案" in out["no_profile_hint"]
    assert "agentbus init" in out["no_profile_hint"]


def test_send_message_multi_target_partial_offline_rejects_all(mcp_env):
    """多目标部分离线 → 整体拒发（在线的也不投）"""
    import server
    now = datetime.now(timezone.utc)
    server._metrics_store.update("pay/carol", {"injected_ok": 1}, now.isoformat())
    out = _tool(mcp_env, "send_message", {"text": "hi", "to": ["carol", "bob"]})
    assert "error" in out
    assert out["offline_targets"] == ["pay/bob"]
    assert mcp_env == []


def test_send_message_all_online_delivers_with_unconfirmed(mcp_env):
    """全在线才投递；目标无 SSE 会话仍尽力发布（unconfirmed 兼容语义保留）"""
    import server
    now = datetime.now(timezone.utc)
    server._metrics_store.update("pay/bob", {"injected_ok": 1}, now.isoformat())
    out = _tool(mcp_env, "send_message", {"text": "hi", "to": "bob"})
    assert out["status"] == "sent"
    assert out["unconfirmed"] == ["pay/bob"]
    assert mcp_env == ["/agentbus/ai/channel/pay/bob/message"]


# ─── TASK-32 Task 4：SSE 断开不再清 _agent_info ──────────────────────────


def test_sse_disconnect_keeps_agent_info(monkeypatch):
    """断线仅移路由表；档案/注册态保留（hub 中心化后 finally 不再清 _agent_info）

    TestClient 的 portal 语义下客户端 break 后服务端读循环感知不到断连，
    故用 fake transport 直达 sse_endpoint 的 finally 清理路径。
    """
    import server
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from starlette.requests import Request

    saved = (dict(server._sessions), dict(server._agent_info))
    server._sessions.clear()
    server._agent_info.clear()
    old_db = server.DB_CONN
    server.DB_CONN = None  # 不碰真库

    @asynccontextmanager
    async def fake_connect_sse(scope, receive, send):
        yield [object(), object(), object()]

    monkeypatch.setattr(server.sse_transport, "connect_sse", fake_connect_sse)
    try:
        scope = {"type": "http", "path": "/sse", "query_string": b"client_id=keep&ns=iot",
                 "headers": []}
        request = Request(scope, receive=AsyncMock(side_effect=Exception("client gone")))
        asyncio.run(server.sse_endpoint(request))

        assert "iot/keep" in server._agent_info   # 档案条目保留（不再随断连 pop）
        assert "iot/keep" not in server._sessions  # 路由表照旧移除
    finally:
        server.DB_CONN = old_db
        server._sessions.clear(); server._sessions.update(saved[0])
        server._agent_info.clear(); server._agent_info.update(saved[1])
