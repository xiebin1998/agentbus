"""TASK-26: 账号/团队管理 —— 团队登记 + 一团队一账号 ACL 契约

契约（架构 3.1.1 / 三期清单）：
- 团队名即 ns（小写字母/数字/中划线），broker 账号 = team-<团队名>
- ACL 渲染：hub 账号全量 readwrite #；团队账号 readwrite /agentbus/ai/channel/<ns>/#、
  write /agentbus/ai/metric/<ns>/#（跨团队 publish 被 broker 拒，验收项）
- 控制台 API：GET/POST /api/console/teams、DELETE /api/console/teams/{name}，
  受 TASK-25 token 鉴权保护
"""

import pytest
from starlette.testclient import TestClient

import server


# ─── 纯函数层 ───────────────────────────────────────────────────────────────

def test_team_broker_user():
    assert server.team_broker_user("iot") == "team-iot"
    assert server.team_broker_user("pay-core") == "team-pay-core"


def test_render_broker_acl():
    acl = server.render_broker_acl("agentbus", [{"name": "iot"}, {"name": "pay"}])
    # hub 账号全量
    assert "user agentbus" in acl
    hub_block = acl.split("user agentbus", 1)[1].split("user team-", 1)[0]
    assert "topic readwrite #" in hub_block
    # 团队账号仅本 ns 前缀
    assert "user team-iot" in acl
    iot_block = acl.split("user team-iot", 1)[1].split("user ", 1)[0]
    assert "topic readwrite /agentbus/ai/channel/iot/#" in iot_block
    assert "topic write /agentbus/ai/metric/iot/#" in iot_block
    assert "pay" not in iot_block
    assert "user team-pay" in acl


def test_team_store_crud():
    store = server.TeamStore()
    assert store.list() == {}
    entry = store.create("iot", members=["iot/fe-zhangsan"])
    assert entry["name"] == "iot"
    assert entry["broker_user"] == "team-iot"
    assert entry["members"] == ["iot/fe-zhangsan"]
    assert store.create("iot") is None            # 重复 → 拒
    assert store.create("Bad_Name") is None       # 非法命名 → 拒
    assert store.create("") is None
    assert store.delete("iot") is True
    assert store.delete("iot") is False
    assert store.list() == {}


# ─── 路由层 ─────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(server.app)


def test_teams_api_crud(client):
    assert client.get("/api/console/teams").json() == {"teams": []}

    r = client.post("/api/console/teams", json={"name": "iot", "members": ["iot/a"]})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "created"
    assert body["team"]["broker_user"] == "team-iot"

    teams = client.get("/api/console/teams").json()["teams"]
    assert [t["name"] for t in teams] == ["iot"]

    assert client.delete("/api/console/teams/iot").status_code == 200
    assert client.delete("/api/console/teams/iot").status_code == 404
    assert client.get("/api/console/teams").json() == {"teams": []}


def test_teams_api_rejects_invalid_or_duplicate(client):
    assert client.post("/api/console/teams", json={"name": ""}).status_code == 400
    assert client.post("/api/console/teams", json={"name": "Bad/Name"}).status_code == 400
    assert client.post("/api/console/teams", json={"name": "pay"}).status_code == 200
    assert client.post("/api/console/teams", json={"name": "pay"}).status_code == 409
    client.delete("/api/console/teams/pay")


def test_teams_api_requires_token(monkeypatch):
    """TASK-25 鉴权覆盖新端点"""
    monkeypatch.setenv("MCP_API_TOKEN", "s3cret")
    with TestClient(server.app_with_auth) as c:
        assert c.get("/api/console/teams").status_code == 401
        assert c.get("/api/console/teams?token=s3cret").status_code == 200
