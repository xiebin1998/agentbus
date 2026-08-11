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


def test_accounts_search_and_member_put_404(client):
    """成员添加用检索：匹配/大小写不敏感/空参 400/未登录 401；绑定不存在账号 404"""
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    client.post("/api/console/accounts", json={"username": "bob", "password": "pw2"})
    r = client.get("/api/console/accounts/search", params={"q": "bo"})
    assert r.status_code == 200 and [a["username"] for a in r.json()] == ["bob"]
    assert [a["username"] for a in client.get("/api/console/accounts/search", params={"q": "BOB"}).json()] == ["bob"]
    assert client.get("/api/console/accounts/search", params={"q": "zz"}).json() == []
    assert client.get("/api/console/accounts/search").status_code == 400
    # 绑定不存在账号 → 404（不再依赖 FK 报错）
    assert client.put("/api/console/namespaces/pay/members/ghost").status_code == 404
    # 未登录 401
    client.post("/api/auth/logout")
    assert client.get("/api/console/accounts/search", params={"q": "bo"}).status_code == 401


def test_super_admin_password_change_without_dynsec_client(app_ctx, client):
    """复现修复：超管在 broker 无 client（set_client_password 报 Client not found），改密仍应成功"""
    from hub import dynsec as hub_dynsec

    class NotFoundDynsec:
        def __getattr__(self, name):
            def call(*a, **k):
                if name == "set_client_password":
                    raise hub_dynsec.DynsecError("Client not found")
            return call

    app_ctx.DYNSEC_CLIENT = NotFoundDynsec()
    _login(client, "root", "rootpw")
    assert client.post("/api/console/accounts/root/password", json={"password": "newpw"}).status_code == 200
    client.post("/api/auth/logout")
    _login(client, "root", "newpw")   # 新密码可登录


def test_ns_patch_update(client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "旧",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    client.post("/api/console/namespaces", json={"id": "iot", "name": "物联", "description": "",
                                                 "admin_username": "iot-admin", "admin_password": "pw2"})
    # 超管改名称+描述
    assert client.patch("/api/console/namespaces/pay", json={"name": "支付中台", "description": "新"}).status_code == 200
    pay = next(n for n in client.get("/api/console/namespaces").json() if n["id"] == "pay")
    assert pay == {"id": "pay", "name": "支付中台", "description": "新"}
    # id 不可改：未知字段一律 400
    assert client.patch("/api/console/namespaces/pay", json={"id": "pay2"}).status_code == 400
    assert client.patch("/api/console/namespaces/pay", json={}).status_code == 400
    assert client.patch("/api/console/namespaces/pay", json={"name": "  "}).status_code == 400
    assert client.patch("/api/console/namespaces/ghost", json={"name": "x"}).status_code == 404
    # ns_admin 只能改自己管的 ns
    client.post("/api/auth/logout")
    _login(client, "pay-admin", "pw1")
    assert client.patch("/api/console/namespaces/pay", json={"description": "成员可改"}).status_code == 200
    assert client.patch("/api/console/namespaces/iot", json={"name": "越权"}).status_code == 403
    # 未登录 401
    client.post("/api/auth/logout")
    assert client.patch("/api/console/namespaces/pay", json={"name": "x"}).status_code == 401
