"""TASK-32 Task 3：init 注册端点 + 指标占位行（顺序契约）。

隔离环境：临时 SQLite + 假 dynsec + 不连真实 broker（同 test_server_console_v4）。
"""
import base64

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
