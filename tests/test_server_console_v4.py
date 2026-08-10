"""四期：控制台 API v4（session 鉴权 + 账号/ns 管理 + 指标 ns 过滤）

隔离环境：临时 SQLite + 假 dynsec（不连真实 broker）+ 引导超管 root/rootpw。
"""
import pytest
from starlette.testclient import TestClient


@pytest.fixture()
def app_ctx(monkeypatch, tmp_path):
    """构造隔离环境：临时 SQLite + 假 dynsec + 不连真实 broker。"""
    monkeypatch.setenv("AGENTBUS_DB_PATH", str(tmp_path / "agentbus.db"))
    monkeypatch.setenv("AGENTBUS_ADMIN_USER", "root")
    monkeypatch.setenv("AGENTBUS_ADMIN_PASSWORD", "rootpw")

    class FakeDynsec:  # 只记录，不连 MQTT
        def __getattr__(self, name):
            def call(*a, **k):
                pass
            return call

    import server
    server.DYNSEC_CLIENT = FakeDynsec()
    server.init_hub_state()   # 建库 + 引导超管（幂等）
    return server


@pytest.fixture()
def client(app_ctx):
    return TestClient(app_ctx.app)


def _login(c, user, pw):
    r = c.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return r


def test_login_me_logout(client):
    r = client.post("/api/auth/login", json={"username": "root", "password": "wrong"})
    assert r.status_code == 401
    _login(client, "root", "rootpw")
    me = client.get("/api/me").json()
    assert me["username"] == "root" and me["role"] == "super_admin" and me["namespaces"] == []
    client.post("/api/auth/logout")
    assert client.get("/api/me").status_code == 401


def test_namespace_lifecycle_and_permission_filter(client):
    _login(client, "root", "rootpw")
    r = client.post("/api/console/namespaces", json={
        "id": "pay", "name": "支付", "description": "支付线",
        "admin_username": "pay-admin", "admin_password": "pw1"})
    assert r.status_code == 200
    assert client.get("/api/console/namespaces").json()[0]["id"] == "pay"
    # 新账号未授权前看不到任何 ns
    client.post("/api/auth/logout")
    _login(client, "pay-admin", "pw1")
    assert [n["id"] for n in client.get("/api/console/namespaces").json()] == ["pay"]


def test_accounts_and_binding(client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    assert client.post("/api/console/accounts", json={"username": "bob", "password": "pw2"}).status_code == 200
    assert client.put("/api/console/namespaces/pay/members/bob").status_code == 200
    members = client.get("/api/console/accounts?ns=pay").json()
    assert {m["username"] for m in members} == {"pay-admin", "bob"}
    assert client.delete("/api/console/namespaces/pay/members/bob").status_code == 200
    assert client.post("/api/console/accounts/bob/password", json={"password": "pw3"}).status_code == 200
    assert client.delete("/api/console/accounts/bob").status_code == 200


def test_ns_admin_cannot_manage_other_ns(client):
    _login(client, "root", "rootpw")
    for ns, adm in [("pay", "pay-admin"), ("iot", "iot-admin")]:
        client.post("/api/console/namespaces", json={"id": ns, "name": ns, "description": "",
                                                     "admin_username": adm, "admin_password": "pw"})
    client.post("/api/auth/logout")
    _login(client, "pay-admin", "pw")
    assert [n["id"] for n in client.get("/api/console/namespaces").json()] == ["pay"]
    assert client.put("/api/console/namespaces/iot/members/pay-admin").status_code == 403
    assert client.delete("/api/console/namespaces/iot").status_code == 403


def test_metrics_ns_filter(app_ctx, client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    app_ctx._metrics_store.update("pay/demo-daemon", {"injected_ok": 3}, "t")
    app_ctx._metrics_store.update("iot/other-daemon", {"injected_ok": 5}, "t")
    # 缺 ns 参数 400
    assert client.get("/api/console/metrics").status_code == 400
    r = client.get("/api/console/metrics", params={"ns": "pay"})
    assert r.status_code == 200
    assert "pay/demo-daemon" in r.json()["daemons"]
    assert "iot/other-daemon" not in r.json()["daemons"]
    s = client.get("/api/console/metrics/summary", params={"ns": "pay"}).json()
    assert s["daemon_count"] == 1 and s["totals"]["injected_ok"] == 3
    # 未登录 401；未授权 ns 的普通账号 403
    client.post("/api/auth/logout")
    assert client.get("/api/console/metrics", params={"ns": "pay"}).status_code == 401
    _login(client, "pay-admin", "pw1")
    assert client.get("/api/console/metrics", params={"ns": "iot"}).status_code == 403


def test_connect_command(client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    r = client.get("/api/console/connect-command", params={"ns": "pay"})
    data = r.json()
    assert data["broker"] and data["user"] == "root" and data["ns"] == "pay"
    assert "password" not in data  # 服务端不回显真实密码（单向哈希）
