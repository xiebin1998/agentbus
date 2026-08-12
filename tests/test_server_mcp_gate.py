"""
TASK-32: 去门控回归 —— 无门控全放行；register_agent 工具已删除（调用返回未知工具）；
保留 TASK-31 三源合并（注册信息 × 在线状态 × daemon 指标）。
"""
import asyncio
from datetime import datetime, timezone

import pytest

import server


class TestGateRemoved:
    def test_门控符号已删除(self):
        for attr in ("tool_gate_error", "gate_tool_error",
                     "GATE_METRIC_WINDOW_S", "GATE_EXEMPT_TOOLS", "GATE_HINT"):
            assert not hasattr(server, attr), f"{attr} 应已删除"

    def test_register_agent_已移出工具清单(self):
        names = {t.name for t in server.build_tools()}
        assert "register_agent" not in names
        assert {"update_agent", "send_message", "list_agents",
                "get_agent_info", "find_agents_by_capability", "get_status"} <= names
        # 定位收敛：ack_message 已移除，调用返回未知工具
        assert "ack_message" not in names

    def test_工具描述不再声明门控前提(self):
        for t in server.build_tools():
            assert "门控" not in t.description, f"{t.name} 描述残留门控文案"

    def test_send_message_描述声明仅向在线投递(self):
        tools = {t.name: t for t in server.build_tools()}
        assert "在线" in tools["send_message"].description


async def _call_tool(name, arguments, client_id="gate-t", ns="iot"):
    """在运行中的事件循环内建 MCP server 并直达 call_tool handler（预置假 mcp_session）"""
    from mcp import types
    srv = server.create_mcp_server(client_id, ns)
    server._sessions[session_key_for(client_id, ns)].mcp_session = object()
    handler = srv.request_handlers[types.CallToolRequest]
    req = types.CallToolRequest(method="tools/call",
                                params=types.CallToolRequestParams(name=name, arguments=arguments))
    result = await handler(req)
    return result.root.content[0].text


def session_key_for(client_id, ns):
    return f"{ns}/{client_id}" if ns else client_id


class TestNoGateDispatch:
    @pytest.fixture(autouse=True)
    def isolate(self):
        saved = (dict(server._sessions), dict(server._agent_info))
        server._sessions.clear()
        server._agent_info.clear()
        yield
        server._sessions.clear(); server._sessions.update(saved[0])
        server._agent_info.clear(); server._agent_info.update(saved[1])

    def test_register_agent_调用返回未知工具(self):
        text = asyncio.run(_call_tool("register_agent",
                                      {"name": "x", "description": "y", "capabilities": []}))
        assert "Unknown tool" in text

    def test_ack_message_调用返回未知工具(self):
        """定位收敛：ack_message 已移除（无消费者死重），工具面收敛为 send_message 单一发声方式"""
        text = asyncio.run(_call_tool("ack_message", {"id": "any"}))
        assert "Unknown tool" in text

    def test_未注册未上线不再拦截只读工具(self):
        """无门控：list_agents/get_status 不经注册、不经指标直接放行"""
        import json

        async def run():
            listing = json.loads(await _call_tool("list_agents", {}))
            status = json.loads(await _call_tool("get_status", {}))
            return listing, status

        listing, status = asyncio.run(run())
        assert isinstance(listing, list)
        # to_dict 展开覆盖 client_id 为完整身份（既有行为）
        assert status["client_id"] == "iot/gate-t"


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
        assert fe["name"] == "前端助手" and fe["registered"] is True
        # TASK-33 新口径：online = presence/指标判定（无 presence 无指标 → 离线）；SSE 存活单列 sse_connected
        assert fe["online"] is False and fe["sse_connected"] is True
        assert fe["capabilities"] == ["code"] and fe["description"] == "负责前端"
        be = rows[0]
        assert be["registered"] is False and be["online"] is False and be["sse_connected"] is False
        assert be["metrics"] == {"injected_ok": 5} and be["report_count"] == 2

    def test_空源返回空列表(self):
        assert server.build_agent_detail("iot", {}, {}, {}) == []

    def test_online_用_presence_口径且_sse_connected_两态分离(self):
        """TASK-33：presence=offline 但 SSE 会话存活 → online False + sse_connected True"""
        now = datetime.now(timezone.utc)
        info = server.AgentInfo("iot/x")
        sessions = {"iot/x": object()}
        presence = {"iot/x": {"state": "offline", "ts": now.isoformat()}}
        rows = server.build_agent_detail("iot", {"iot/x": info}, sessions, {},
                                         now=now, presence=presence)
        assert rows[0]["online"] is False        # daemon 离线 → 投递不可达
        assert rows[0]["sse_connected"] is True  # 但 SSE 会话还在（两态分开展示）

    def test_online_presence_online_新鲜心跳(self):
        """presence=online + 新心跳 → online True（无 SSE 会话也不影响）"""
        now = datetime.now(timezone.utc)
        presence = {"iot/y": {"state": "online", "ts": now.isoformat()}}
        metrics = {"iot/y": {"last_seen": now.isoformat(), "report_count": 1}}
        rows = server.build_agent_detail("iot", {}, {}, metrics, now=now, presence=presence)
        assert rows[0]["online"] is True and rows[0]["sse_connected"] is False


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
        monkeypatch.setattr(server, "_presence_store", server.PresenceStore())
        from starlette.testclient import TestClient
        yield TestClient(server.app)
        if server.DB_CONN is not None:
            server.DB_CONN.close()
            server.DB_CONN = None

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
        # TASK-33 新口径：online 由 presence + 心跳决定（SSE 会话单列 sse_connected）
        now_iso = datetime.now(timezone.utc).isoformat()
        server._metrics_store.update("iot/fe", {"injected_ok": 1}, now_iso)
        server._presence_store.update("iot/fe", "online", now_iso, reason="connected")
        r = env.get("/api/console/agents?ns=iot")
        assert r.status_code == 200
        agents = r.json()["agents"]
        assert len(agents) == 1
        a = agents[0]
        assert a["client_id"] == "fe" and a["registered"] and a["online"] and a["sse_connected"]
        assert a["metrics"] == {"injected_ok": 1} and a["name"] == "前端"
