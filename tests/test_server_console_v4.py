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


def test_metrics_online_agents_用_presence_统一口径(app_ctx, client, monkeypatch):
    """TASK-33 DoD-4：overview.online_agents 统计卡走 agent_online，与行内 Badge 同口径"""
    from datetime import datetime, timezone
    monkeypatch.setattr(app_ctx, "_presence_store", app_ctx.PresenceStore())
    monkeypatch.setattr(app_ctx, "_metrics_store", app_ctx.MetricsStore())
    monkeypatch.setattr(app_ctx, "_sessions", {})
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "iot", "name": "iot", "description": "",
                                                 "admin_username": "iot-admin", "admin_password": "pw"})
    now = datetime.now(timezone.utc).isoformat()
    # presence online + 新鲜心跳 → 计入
    app_ctx._presence_store.update("iot/a", "online", now, reason="connected")
    app_ctx._metrics_store.update("iot/a", {"injected_ok": 1}, now)
    # presence offline 但 SSE 会话存活 → 不计入（旧 SSE 口径会误计）
    app_ctx._presence_store.update("iot/b", "offline", now, reason="graceful_stop")
    app_ctx._sessions["iot/b"] = object()
    r = client.get("/api/console/metrics", params={"ns": "iot"}).json()
    assert r["overview"]["online_agents"] == ["iot/a"]



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
    assert pay == {"id": "pay", "name": "支付中台", "description": "新",
                   "owner": "pay-admin", "owner_display_name": ""}
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


def test_permission_matrix_password_and_delete(client):
    """改密仅超管（或本人改自己）；删号仅超管；ns_admin 两者均无权"""
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    client.post("/api/console/accounts", json={"username": "bob", "password": "pw2"})
    client.put("/api/console/namespaces/pay/members/bob")
    client.post("/api/auth/logout")

    # ns_admin 改成员密码 → 403；删成员账号 → 403
    _login(client, "pay-admin", "pw1")
    assert client.post("/api/console/accounts/bob/password", json={"password": "x"}).status_code == 403
    assert client.delete("/api/console/accounts/bob").status_code == 403
    # ns_admin 可改自己密码
    assert client.post("/api/console/accounts/pay-admin/password", json={"password": "pw1b"}).status_code == 200
    client.post("/api/auth/logout")

    # 普通用户改他人 403，改自己 200
    _login(client, "bob", "pw2")
    assert client.post("/api/console/accounts/pay-admin/password", json={"password": "x"}).status_code == 403
    assert client.post("/api/console/accounts/bob/password", json={"password": "pw2b"}).status_code == 200
    assert client.delete("/api/console/accounts/pay-admin").status_code == 403
    client.post("/api/auth/logout")

    # 超管改他人/删号均可
    _login(client, "root", "rootpw")
    assert client.post("/api/console/accounts/bob/password", json={"password": "pw2c"}).status_code == 200
    assert client.delete("/api/console/accounts/bob").status_code == 200


def test_ns_admin_create_account_constraints(client):
    """ns_admin 建号：必须挂自己可管理的 ns，角色固定普通用户；user 无权建号"""
    _login(client, "root", "rootpw")
    for ns, adm in [("pay", "pay-admin"), ("iot", "iot-admin")]:
        client.post("/api/console/namespaces", json={"id": ns, "name": ns, "description": "",
                                                     "admin_username": adm, "admin_password": "pw"})
    client.post("/api/console/accounts", json={"username": "bob", "password": "pw2"})
    client.post("/api/auth/logout")

    _login(client, "pay-admin", "pw")
    # 不带 ns → 403；挂他人 ns → 403
    assert client.post("/api/console/accounts", json={"username": "c1", "password": "p"}).status_code == 403
    assert client.post("/api/console/accounts", json={"username": "c1", "password": "p", "ns": "iot"}).status_code == 403
    # 挂自己 ns → 200，且角色固定 user（即使恶意传 role 也无效）
    r = client.post("/api/console/accounts",
                    json={"username": "c1", "password": "p", "ns": "pay", "display_name": "成员一"})
    assert r.status_code == 200
    client.post("/api/auth/logout")

    _login(client, "root", "rootpw")
    assert {m["username"] for m in client.get("/api/console/accounts?ns=pay").json()} == {"pay-admin", "c1"}
    c1 = next(a for a in client.get("/api/console/accounts").json() if a["username"] == "c1")
    assert c1["role"] == "user" and c1["display_name"] == "成员一"

    # 普通用户建号 → 403
    client.post("/api/auth/logout")
    _login(client, "bob", "pw2")
    assert client.post("/api/console/accounts", json={"username": "c2", "password": "p"}).status_code == 403


def test_owner_column_and_non_owner_member_readonly(app_ctx, client):
    """ns 列表带 owner；非 owner 的成员（即使 ns_admin 角色）只读"""
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    client.post("/api/console/accounts", json={"username": "other-admin", "password": "pw"})
    from hub import store as hub_store
    hub_store.set_role(app_ctx.DB_CONN, "other-admin", "ns_admin")
    client.put("/api/console/namespaces/pay/members/other-admin")
    assert client.get("/api/console/namespaces").json()[0]["owner"] == "pay-admin"
    client.post("/api/auth/logout")

    # other-admin 是成员且是 ns_admin 角色，但非 owner：编辑/成员管理均 403
    _login(client, "other-admin", "pw")
    assert client.patch("/api/console/namespaces/pay", json={"name": "越权"}).status_code == 403
    assert client.put("/api/console/namespaces/pay/members/pay-admin").status_code == 403


def test_null_owner_fallback_legacy_ns(app_ctx, client):
    """历史 ns（owner 为 NULL）回退旧规则：属该 ns 的 ns_admin 仍可管理"""
    from hub import store as hub_store, auth as hub_auth
    db = app_ctx.DB_CONN
    hub_store.create_namespace(db, "legacy", "遗留", "", owner=None)
    hub_store.create_user(db, "legacy-admin", hub_auth.hash_password("pw"), "ns_admin")
    hub_store.bind_member(db, "legacy", "legacy-admin")

    _login(client, "legacy-admin", "pw")
    assert client.patch("/api/console/namespaces/legacy", json={"description": "可改"}).status_code == 200
    assert client.post("/api/console/accounts", json={"username": "m1", "password": "p", "ns": "legacy"}).status_code == 200


def test_display_name_lifecycle(client):
    """昵称：建号写入、列表/检索/me 返回、PATCH 修改（超管改他人/本人改自己/越权 403）"""
    _login(client, "root", "rootpw")
    client.post("/api/console/accounts", json={"username": "bob", "password": "pw", "display_name": "张三"})
    assert next(a for a in client.get("/api/console/accounts").json()
                if a["username"] == "bob")["display_name"] == "张三"
    # 昵称也可被检索
    assert [a["username"] for a in client.get("/api/console/accounts/search", params={"q": "张"}).json()] == ["bob"]
    # 超管改他人昵称
    assert client.patch("/api/console/accounts/bob", json={"display_name": "李四"}).status_code == 200
    assert client.patch("/api/console/accounts/bob", json={"role": "user"}).status_code == 400  # 仅 display_name
    assert client.patch("/api/console/accounts/ghost", json={"display_name": "x"}).status_code == 404
    # login/me 带昵称
    client.post("/api/auth/logout")
    r = _login(client, "bob", "pw")
    assert r.json()["display_name"] == "李四"
    assert client.get("/api/me").json()["display_name"] == "李四"
    # 本人改自己 200；改他人 403
    assert client.patch("/api/console/accounts/bob", json={"display_name": "王五"}).status_code == 200
    assert client.patch("/api/console/accounts/root", json={"display_name": "x"}).status_code == 403


def test_connect_command_install_urls(client):
    """接入命令返回两种安装方式的脚本 URL"""
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    data = client.get("/api/console/connect-command", params={"ns": "pay"}).json()
    # PS 为“下载临时文件再 iex”形态（PS 5.1 的 iwr .Content 按 ANSI 解码致中文乱码）
    assert data["install_ps1"].startswith("$env:AGENTBUS_INSTALL=") and "-OutFile" in data["install_ps1"]
    assert data["install_sh"].startswith("curl -fsSL ") and data["install_sh"].endswith("/install.sh | bash")


def _mk_ns(c):
    c.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                            "admin_username": "pay-admin", "admin_password": "pw1"})


def test_connect_command_real_host(client, app_ctx):
    """broker 地址与脚本 URL 按浏览器请求的真实 host 生成（跨机器可达）"""
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"},
                      headers={"host": "192.168.1.50:8000"}).json()
    assert data["broker"] == f"192.168.1.50:{app_ctx.MQTT_BROKER_PORT}"
    assert "http://192.168.1.50:8000/install.ps1" in data["install_ps1"]
    assert "http://192.168.1.50:8000/install.sh" in data["install_sh"]


def test_connect_command_forwarded_host(client, app_ctx):
    """反向代理场景：X-Forwarded-Host 优先于直连 host"""
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"},
                      headers={"host": "127.0.0.1:8000", "x-forwarded-host": "hub.example.com"}).json()
    assert data["broker"] == f"hub.example.com:{app_ctx.MQTT_BROKER_PORT}"
    assert "hub.example.com/install.ps1" in data["install_ps1"]


def test_connect_command_public_broker_override(client, app_ctx, monkeypatch):
    """分机部署：AGENTBUS_PUBLIC_BROKER 环境变量覆盖 broker 地址"""
    monkeypatch.setattr(app_ctx, "PUBLIC_BROKER", "10.0.0.5:18830")
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"}).json()
    assert data["broker"] == "10.0.0.5:18830"


def test_connect_command_public_port(client, app_ctx, monkeypatch):
    """Docker 部署：容器内端口不可对外，按 AGENTBUS_BROKER_PUBLIC_PORT 派生（host 随浏览器）"""
    monkeypatch.setattr(app_ctx, "PUBLIC_BROKER_PORT", "18830")
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"},
                      headers={"host": "192.168.1.50:8000"}).json()
    assert data["broker"] == "192.168.1.50:18830"


def test_connect_command_real_broker_host_kept(client, app_ctx, monkeypatch):
    """MQTT_BROKER_HOST 已是真实可达地址（如公网 IP）时沿用，不按浏览器 host 派生"""
    monkeypatch.setattr(app_ctx, "MQTT_BROKER_HOST", "106.14.126.2")
    monkeypatch.setattr(app_ctx, "MQTT_BROKER_PORT", 1884)
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"},
                      headers={"host": "192.168.1.50:8000"}).json()
    assert data["broker"] == "106.14.126.2:1884"
    # 脚本下载源仍按浏览器 host（与 broker 是否同机无关，hub 就是浏览器正在访问的服务）
    assert "http://192.168.1.50:8000/install.ps1" in data["install_ps1"]


def test_connect_command_one_line_scripts(client):
    """一行式脚本命令：预置环境变量（含凭证占位），密码前端替换；未选工具时不带 AGENTBUS_TOOLS（自动探测）"""
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay"}).json()
    ps1, sh = data["install_cmd_ps1"], data["install_cmd_sh"]
    assert "$env:AGENTBUS_BROKER=" in ps1 and "$env:AGENTBUS_USER=" in ps1
    assert "$env:AGENTBUS_PASSWORD='<密码>'" in ps1 and "$env:AGENTBUS_NS=" in ps1
    assert ps1.endswith("iex $env:AGENTBUS_INSTALL") and "-OutFile $env:AGENTBUS_INSTALL" in ps1
    assert sh.startswith("AGENTBUS_BROKER=") and "AGENTBUS_USER=" in sh
    assert "AGENTBUS_PASSWORD='<密码>'" in sh and "AGENTBUS_NS=" in sh
    assert sh.endswith("| bash")
    # 未选工具 → 不注入 AGENTBUS_TOOLS，init --yes 自动探测已装 CLI
    assert "AGENTBUS_TOOLS" not in ps1 and "AGENTBUS_TOOLS" not in sh and "--tools" not in data["template"]


def test_connect_command_tools_param(client):
    """tools 参数：透传进模板与一行式命令（AGENTBUS_TOOLS 逗号分隔），非法工具名 400"""
    _login(client, "root", "rootpw")
    _mk_ns(client)
    data = client.get("/api/console/connect-command", params={"ns": "pay", "tools": "qoder,claude"}).json()
    assert "--tools qoder claude" in data["template"]
    assert "AGENTBUS_TOOLS='qoder,claude'" in data["install_cmd_ps1"].replace("$env:", "")
    assert "AGENTBUS_TOOLS='qoder,claude'" in data["install_cmd_sh"]
    # 可选清单随响应下发（前端渲染选择控件用）
    assert data["tools_options"] == ["qoder", "kilo", "opencode", "claude", "codex", "hermes"]
    assert data["tools"] == ["qoder", "claude"]
    # 未知工具名直接 400（防注入，不信任前端）
    assert client.get("/api/console/connect-command",
                      params={"ns": "pay", "tools": "qoder;rm"}).status_code == 400
    assert client.get("/api/console/connect-command",
                      params={"ns": "pay", "tools": "unknown-tool"}).status_code == 400
