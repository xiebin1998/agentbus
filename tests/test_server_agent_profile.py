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


# ─── TASK-32 Task 5：快照端点（DB 档案 × 在线态） ────────────────────


def test_snapshot_requires_auth(client):
    assert client.get("/api/agent/snapshot?ns=pay").status_code == 401


def test_snapshot_missing_ns_400(client, app_ctx):
    from hub import store, auth
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user")
    r = client.get("/api/agent/snapshot", headers=_basic("alice", "pw"))
    assert r.status_code == 400


def test_snapshot_merges_db_and_online(client, app_ctx):
    """DB 档案全量下发；online=last_seen 90s 窗口；owner_display_name join users"""
    from hub import store, auth
    store.create_user(app_ctx.DB_CONN, "alice", auth.hash_password("pw"), "user",
                      display_name="小爱")
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-on", name="在线者",
                       description="d1", capabilities=["chat"], tools=["t1"], owner="alice")
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-off", name="离线者", owner="alice")
    app_ctx._metrics_store.update("pay/ag-on", {"injected_ok": 1},
                                  datetime.now(timezone.utc).isoformat())
    r = client.get("/api/agent/snapshot?ns=pay", headers=_basic("alice", "pw"))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["generated_at"]
    by_cid = {a["client_id"]: a for a in data["agents"]}
    assert set(by_cid) == {"ag-on", "ag-off"}
    on = by_cid["ag-on"]
    assert on["online"] is True
    assert on["name"] == "在线者" and on["description"] == "d1"
    assert on["capabilities"] == ["chat"] and on["tools"] == ["t1"]
    assert on["owner_display_name"] == "小爱"
    off = by_cid["ag-off"]
    assert off["online"] is False
    # 无指标记录的目标也下发（online=False）；owner 为空时不带 owner_display_name
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-orphan", name="无主", owner="")
    r = client.get("/api/agent/snapshot?ns=pay", headers=_basic("alice", "pw"))
    orphan = {a["client_id"]: a for a in r.json()["agents"]}["ag-orphan"]
    assert orphan["online"] is False
    assert "owner_display_name" not in orphan or not orphan["owner_display_name"]


def test_snapshot_token_channel(client, app_ctx, monkeypatch):
    """MCP_API_TOKEN 通道亦可读快照（daemon 轮询同凭证）"""
    from hub import store
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-1", name="A")
    monkeypatch.setenv("MCP_API_TOKEN", "sekret")
    assert client.get("/api/agent/snapshot?ns=pay&token=sekret").status_code == 200
    assert client.get("/api/agent/snapshot?ns=pay&token=nope").status_code == 401


# ─── TASK-32 Task 5：update_agent 工具直写 DB（自述） ──────────────────


@pytest.fixture()
def mcp_db_env(monkeypatch, tmp_path):
    """临时 DB + 隔离会话/指标全局态 + 就绪事件已置位（自述工具直写库验证用）"""
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
    saved = (dict(server._sessions), dict(server._agent_info))
    server._sessions.clear()
    server._agent_info.clear()
    old_metrics, old_ready = server._metrics_store, server._shared_ready
    server._metrics_store = server.MetricsStore()
    ev = threading.Event()
    ev.set()
    server._shared_ready = ev
    yield server
    server._metrics_store, server._shared_ready = old_metrics, old_ready
    server._sessions.clear(); server._sessions.update(saved[0])
    server._agent_info.clear(); server._agent_info.update(saved[1])
    if server.DB_CONN is not None:
        server.DB_CONN.close()
        server.DB_CONN = None


def test_update_agent_tool_writes_db(mcp_db_env):
    """自述 name/description/capabilities 直接落库（占位行已有）"""
    from hub import store
    mcp_db_env._handle_metric_message(_metric("pay", "alice"))  # 占位行 name=alice
    out = _tool(None, "update_agent", {"name": "支付助手", "description": "处理支付",
                                       "capabilities": ["pay"]})
    assert out["status"] == "updated"
    a = store.get_agent(mcp_db_env.DB_CONN, "pay", "alice")
    assert a["name"] == "支付助手"
    assert a["description"] == "处理支付"
    assert a["capabilities"] == ["pay"]


def test_update_agent_tool_creates_row_when_absent(mcp_db_env):
    """无占位行时自述也能建档（owner 留空待注册补齐）"""
    from hub import store
    out = _tool(None, "update_agent", {"name": "自述者", "capabilities": ["x"]})
    assert out["status"] == "updated"
    a = store.get_agent(mcp_db_env.DB_CONN, "pay", "alice")
    assert a is not None and a["name"] == "自述者"
    assert a["capabilities"] == ["x"]
    assert a["owner"] == ""


def test_update_agent_tool_name_too_long(mcp_db_env):
    out = _tool(None, "update_agent", {"name": "x" * 51})
    assert "error" in out


def test_update_agent_schema_declares_self_profile_fields():
    """工具 schema 声明 name/description 自述参数，描述声明自述用法"""
    from server import build_tools
    t = {x.name: x for x in build_tools()}["update_agent"]
    props = t.inputSchema["properties"]
    assert "name" in props and "description" in props
    assert "自述" in t.description


def test_get_status_reads_db_profile(mcp_db_env):
    """get_status 返回读 DB 的自身档案 + 在线态"""
    from hub import store
    store.upsert_agent(mcp_db_env.DB_CONN, "pay", "alice", name="支付助手",
                       description="d", capabilities=["pay"])
    out = _tool(None, "get_status", {})
    assert out["name"] == "支付助手"
    assert out["description"] == "d"
    assert out["capabilities"] == ["pay"]
    assert out["online"] is False  # 无近期指标
    mcp_db_env._metrics_store.update("pay/alice", {"injected_ok": 1},
                                     datetime.now(timezone.utc).isoformat())
    out = _tool(None, "get_status", {})
    assert out["online"] is True


# ─── TASK-32 Task 5：PATCH /api/console/agents/{cid} ─────────────────────


@pytest.fixture()
def console_env(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTBUS_DB_PATH", str(tmp_path / "agentbus.db"))
    monkeypatch.setenv("AGENTBUS_ADMIN_USER", "root")
    monkeypatch.setenv("AGENTBUS_ADMIN_PASSWORD", "rootpw")

    class FakeDynsec:
        def __getattr__(self, name):
            def call(*a, **k):
                pass
            return call

    import server
    server.DYNSEC_CLIENT = FakeDynsec()
    server.init_hub_state()
    monkeypatch.setattr(server, "_agent_info", {})
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_metrics_store", server.MetricsStore())
    yield TestClient(server.app)
    if server.DB_CONN is not None:
        server.DB_CONN.close()
        server.DB_CONN = None


def _mk_ns(client):
    client.post("/api/console/namespaces", json={"id": "iot", "name": "iot", "description": "",
                                                  "admin_username": "iot-adm", "admin_password": "pw"})


def test_patch_agent_requires_login(console_env):
    assert console_env.patch("/api/console/agents/ag-1?ns=iot",
                             json={"name": "x"}).status_code == 401


def test_patch_agent_forbidden_for_plain_member(console_env):
    console_env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
    _mk_ns(console_env)
    console_env.post("/api/console/accounts", json={"username": "bob", "password": "pw2"})
    console_env.post("/api/auth/logout")
    console_env.post("/api/auth/login", json={"username": "bob", "password": "pw2"})
    assert console_env.patch("/api/console/agents/ag-1?ns=iot",
                             json={"name": "x"}).status_code == 403


def test_patch_agent_success_writes_db(console_env):
    import server
    from hub import store
    console_env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
    _mk_ns(console_env)
    store.upsert_agent(server.DB_CONN, "iot", "ag-1", name="旧名", description="旧述",
                       capabilities=["a"], owner="root")
    r = console_env.patch("/api/console/agents/ag-1?ns=iot",
                          json={"name": "新名", "description": "新述", "capabilities": ["b"]})
    assert r.status_code == 200, r.text
    a = store.get_agent(server.DB_CONN, "iot", "ag-1")
    assert a["name"] == "新名" and a["description"] == "新述"
    assert a["capabilities"] == ["b"]
    assert a["owner"] == "root"  # PATCH 不改 owner


def test_patch_agent_name_too_long_400(console_env):
    import server
    from hub import store
    console_env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
    _mk_ns(console_env)
    store.upsert_agent(server.DB_CONN, "iot", "ag-1", name="旧")
    r = console_env.patch("/api/console/agents/ag-1?ns=iot", json={"name": "x" * 51})
    assert r.status_code == 400


def test_patch_agent_unknown_404(console_env):
    console_env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
    _mk_ns(console_env)
    assert console_env.patch("/api/console/agents/ghost?ns=iot",
                             json={"name": "x"}).status_code == 404


# ─── TASK-32 Task 5：明细 API 补 DB 字段 + hub 重启恢复 ─────────────────


def test_console_agents_detail_includes_db_fields(console_env):
    """/api/console/agents 合并 DB 档案：tools/registered_at/owner/owner_display_name/placeholder"""
    import server
    from hub import store, auth
    console_env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
    _mk_ns(console_env)
    store.create_user(server.DB_CONN, "alice", auth.hash_password("pw"), "user",
                      display_name="小爱")
    store.upsert_agent(server.DB_CONN, "iot", "ag-1", name="真身", tools=["t1"], owner="alice")
    store.upsert_agent(server.DB_CONN, "iot", "ag-ph", name="ag-ph", owner="")  # 占位行
    r = console_env.get("/api/console/agents?ns=iot")
    assert r.status_code == 200
    by_cid = {a["client_id"]: a for a in r.json()["agents"]}
    real = by_cid["ag-1"]
    assert real["tools"] == ["t1"]
    assert real["owner"] == "alice"
    assert real["owner_display_name"] == "小爱"
    assert real["registered_at"]
    assert real["placeholder"] is False
    ph = by_cid["ag-ph"]
    assert ph["placeholder"] is True


def test_build_agent_detail_db_rows_join_union():
    """纯函数：DB 行并入 key 并集（仅有档案无指标/会话的也要可见）"""
    import server
    db = {"ag-db": {"name": "档案者", "description": "d", "capabilities": ["c"],
                    "tools": ["t"], "owner": "alice", "created_at": "2026-08-11 00:00:00",
                    "updated_at": "2026-08-11 00:00:00"}}
    rows = server.build_agent_detail("iot", {}, {}, {}, db)
    assert [r["client_id"] for r in rows] == ["ag-db"]
    r = rows[0]
    assert r["name"] == "档案者" and r["registered"] is True
    assert r["tools"] == ["t"] and r["owner"] == "alice"
    assert r["online"] is False


def test_hub_restart_loads_agents_from_db(app_ctx, monkeypatch):
    """hub 重启：init_hub_state 后 agents 表加载入 _agent_info（registered=True）"""
    from hub import store
    store.upsert_agent(app_ctx.DB_CONN, "pay", "ag-r", name="重启幸存者",
                       description="d", capabilities=["x"], owner="alice")
    # 模拟重启：旧连接关闭，全局档案清空，重新 init
    app_ctx.DB_CONN.close()
    app_ctx.DB_CONN = None
    monkeypatch.setattr(app_ctx, "_agent_info", {})
    app_ctx.init_hub_state()
    info = app_ctx._agent_info["pay/ag-r"]
    assert info.registered is True
    assert info.name == "重启幸存者"
    assert info.description == "d"
    assert info.capabilities == ["x"]
