"""
TASK-31: MCP 工具双门控 —— 已注册 + daemon 指标新鲜（未达标拒绝，带自愈指引）

- tool_gate_error 纯函数：未注册/无指标/指标过期 → 拒绝文案；新鲜 → None 放行
- gate_tool_error：入口接线层（豁免 register_agent/get_status，其余走双门控）
- build_tools 描述声明门控前提（LLM 可见，利于自愈）
- /api/console/agents：注册信息 × 在线状态 × daemon 指标 三源合并（TASK-31 问题2）
"""
from datetime import datetime, timedelta, timezone

import pytest

import server


def _fresh_entry(now: datetime) -> dict:
    return {"last_seen": now.isoformat(), "report_count": 3, "metrics": {"injected_ok": 1}}


def _gate(name: str, registered: bool, entry, now: datetime):
    return server.gate_tool_error(name, registered, entry, now)


class TestToolGateError:
    def test_未注册拒绝且指引_register_agent(self):
        now = datetime.now(timezone.utc)
        err = server.tool_gate_error(False, _fresh_entry(now), now)
        assert err is not None and "register_agent" in err

    def test_已注册但无指标条目拒绝且提及_daemon(self):
        now = datetime.now(timezone.utc)
        err = server.tool_gate_error(True, None, now)
        assert err is not None and "daemon" in err

    def test_指标过期拒绝(self):
        now = datetime.now(timezone.utc)
        stale = {"last_seen": (now - timedelta(seconds=120)).isoformat()}
        err = server.tool_gate_error(True, stale, now)
        assert err is not None and "daemon" in err

    def test_窗口内新鲜指标放行(self):
        now = datetime.now(timezone.utc)
        assert server.tool_gate_error(True, _fresh_entry(now), now) is None
        # 边界：60s 前的上报仍在 90s 窗口内
        ok = {"last_seen": (now - timedelta(seconds=60)).isoformat()}
        assert server.tool_gate_error(True, ok, now) is None

    def test_非法时间戳按未上报处理(self):
        now = datetime.now(timezone.utc)
        assert server.tool_gate_error(True, {"last_seen": "not-a-ts"}, now) is not None
        assert server.tool_gate_error(True, {}, now) is not None

    def test_兼容_Z后缀时间戳(self):
        now = datetime.now(timezone.utc)
        entry = {"last_seen": now.isoformat().replace("+00:00", "Z")}
        assert server.tool_gate_error(True, entry, now) is None


class TestGateToolError:
    def test_豁免工具不受门控(self):
        now = datetime.now(timezone.utc)
        assert _gate("register_agent", False, None, now) is None
        assert _gate("get_status", False, None, now) is None

    def test_业务工具未注册拒绝(self):
        now = datetime.now(timezone.utc)
        for name in ["send_message", "update_agent", "ack_message",
                     "list_agents", "get_agent_info", "find_agents_by_capability"]:
            assert _gate(name, False, _fresh_entry(now), now) is not None

    def test_业务工具注册且指标新鲜放行(self):
        now = datetime.now(timezone.utc)
        assert _gate("send_message", True, _fresh_entry(now), now) is None


class TestToolDescriptionsMentionGate:
    def test_受门控工具描述声明前提(self):
        tools = {t.name: t for t in server.build_tools()}
        for name in ["send_message", "update_agent", "ack_message",
                     "list_agents", "get_agent_info", "find_agents_by_capability"]:
            assert "门控" in tools[name].description or "拒绝" in tools[name].description, \
                f"{name} 描述应声明门控前提"


class TestBuildAgentDetail:
    def test_三源合并且按_ns_过滤(self):
        info = server.AgentInfo("iot/fe")
        info.registered = True
        info.name = "前端助手"
        info.description = "负责前端"
        info.capabilities = ["code"]
        agent_info = {"iot/fe": info, "pay/x": server.AgentInfo("pay/x")}
        sessions = {"iot/fe": object()}
        metrics = {"iot/be": {"last_seen": "2026-08-11T00:00:00+00:00", "report_count": 2,
                               "metrics": {"injected_ok": 5}}}
        rows = server.build_agent_detail("iot", agent_info, sessions, metrics)
        assert [r["client_id"] for r in rows] == ["be", "fe"]  # key 并集按序
        fe = rows[1]
        assert fe["name"] == "前端助手" and fe["registered"] is True and fe["online"] is True
        assert fe["capabilities"] == ["code"] and fe["description"] == "负责前端"
        be = rows[0]
        assert be["registered"] is False and be["online"] is False
        assert be["metrics"] == {"injected_ok": 5} and be["report_count"] == 2

    def test_空源返回空列表(self):
        assert server.build_agent_detail("iot", {}, {}, {}) == []


class TestConsoleAgentsApi:
    @pytest.fixture()
    def env(self, monkeypatch, tmp_path):
        monkeypatch.setenv("AGENTBUS_DB_PATH", str(tmp_path / "agentbus.db"))
        monkeypatch.setenv("AGENTBUS_ADMIN_USER", "root")
        monkeypatch.setenv("AGENTBUS_ADMIN_PASSWORD", "rootpw")

        class FakeDynsec:
            def __getattr__(self, name):
                def call(*a, **k):
                    pass
                return call

        server.DYNSEC_CLIENT = FakeDynsec()
        server.init_hub_state()
        # 隔离全局态：测试内预置，monkeypatch 自动还原
        monkeypatch.setattr(server, "_agent_info", {})
        monkeypatch.setattr(server, "_sessions", {})
        monkeypatch.setattr(server, "_metrics_store", server.MetricsStore())
        from starlette.testclient import TestClient
        return TestClient(server.app)

    def test_未登录_401(self, env):
        assert env.get("/api/console/agents?ns=iot").status_code == 401

    def test_缺_ns_参数_400(self, env):
        env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
        assert env.get("/api/console/agents").status_code == 400

    def test_无权限_ns_403(self, env):
        env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
        env.post("/api/console/namespaces", json={"id": "iot", "name": "iot", "description": "",
                                                  "admin_username": "iot-adm", "admin_password": "pw"})
        env.post("/api/console/accounts", json={"username": "bob", "password": "pw2"})
        env.post("/api/auth/logout")
        env.post("/api/auth/login", json={"username": "bob", "password": "pw2"})
        assert env.get("/api/console/agents?ns=iot").status_code == 403

    def test_三源合并下发(self, env):
        env.post("/api/auth/login", json={"username": "root", "password": "rootpw"})
        env.post("/api/console/namespaces", json={"id": "iot", "name": "iot", "description": "",
                                                  "admin_username": "iot-adm", "admin_password": "pw"})
        info = server.AgentInfo("iot/fe")
        info.registered = True
        info.name = "前端"
        info.capabilities = ["ui"]
        server._agent_info["iot/fe"] = info
        server._sessions["iot/fe"] = object()
        server._metrics_store.update("iot/fe", {"injected_ok": 1}, "2026-08-11T00:00:00+00:00")
        r = env.get("/api/console/agents?ns=iot")
        assert r.status_code == 200
        agents = r.json()["agents"]
        assert len(agents) == 1
        a = agents[0]
        assert a["client_id"] == "fe" and a["registered"] and a["online"]
        assert a["metrics"] == {"injected_ok": 1} and a["name"] == "前端"
