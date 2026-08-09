"""TASK-20: Web 控制台后端 API（server.py）

覆盖前端三页（TASK-21）所需：
- ns 页：命名空间清单/声明创建 + 身份清单与检索
- 权限页：allowed_senders/trust_map/inbound_mode 档案的读改与下发（control 消息）
- 指标页：各 daemon 指标 + hub 概览 + 汇总
纯逻辑层函数直接测；路由层用 starlette TestClient 走真实 app。
"""
import server
from starlette.testclient import TestClient


# ─── 纯逻辑层 ────────────────────────────────────────────────────────────────


def test_namespace_registry_declare_and_list():
    reg = server.NamespaceRegistry()
    reg.declare("iot")
    reg.declare("iot")  # 重复声明幂等
    lst = reg.list()
    assert len(lst) == 1
    assert lst[0]["name"] == "iot"
    assert lst[0]["declared"] is True


def test_namespace_registry_declare_invalid():
    reg = server.NamespaceRegistry()
    assert reg.declare("") is None
    assert reg.declare("a/b") is None  # ns 名不允许带分隔符
    assert reg.list() == []


def test_collect_namespaces_merges_all_sources():
    # 在线会话 + 注册信息 + daemon 指标 + 显式声明，四路来源合并去重
    ns_list = server.collect_namespaces(
        session_keys=["default/fe-a", "flat-agent"],
        agent_keys=["iot/agent-b"],
        metric_keys=["iot/daemon-c"],
        declared=[{"name": "prod", "declared_at": "t", "declared": True}],
    )
    by_name = {n["name"]: n for n in ns_list}
    assert set(by_name) == {"default", "flat", "iot", "prod"}
    assert by_name["default"]["online_agents"] == 1
    assert by_name["flat"]["online_agents"] == 1  # 无 ns 会话归入 flat
    assert by_name["iot"]["daemon_count"] == 1
    assert by_name["iot"]["registered_agents"] == 1
    assert by_name["prod"]["declared"] is True


def test_collect_identities_filter_and_search():
    idents = server.collect_identities(
        session_keys={"default/fe-a"},
        agent_keys={"default/fe-a", "iot/agent-b"},
        metric_keys={"iot/daemon-c"},
    )
    # 全量：并集去重
    assert {i["identity"] for i in idents} == {"default/fe-a", "iot/agent-b", "iot/daemon-c"}
    fe = next(i for i in idents if i["identity"] == "default/fe-a")
    assert fe["online"] is True and fe["registered"] is True and fe["has_metrics"] is False
    dc = next(i for i in idents if i["identity"] == "iot/daemon-c")
    assert dc["online"] is False and dc["has_metrics"] is True

    # ns 过滤
    assert {i["identity"] for i in server.collect_identities(
        session_keys=set(), agent_keys={"iot/agent-b"}, metric_keys={"iot/daemon-c"}, ns="iot"
    )} == {"iot/agent-b", "iot/daemon-c"}

    # 关键字检索（子串，大小写不敏感）
    assert {i["identity"] for i in server.collect_identities(
        session_keys=set(), agent_keys={"iot/Agent-B"}, metric_keys=set(), q="agent"
    )} == {"iot/Agent-B"}


def test_validate_permission_profile_ok():
    body = {
        "allowed_senders": ["default/alice", "bob"],
        "trust_map": {"default/alice": "full"},
        "inbound_mode": "readonly",
    }
    assert server.validate_permission_profile(body) == body


def test_validate_permission_profile_partial_and_defaults():
    assert server.validate_permission_profile({}) == {
        "allowed_senders": [], "trust_map": {}, "inbound_mode": "readonly",
    }


def test_validate_permission_profile_rejects_bad_values():
    import pytest
    with pytest.raises(ValueError):
        server.validate_permission_profile({"inbound_mode": "open"})  # 只允许 readonly/full
    with pytest.raises(ValueError):
        server.validate_permission_profile({"trust_map": {"a": "half"}})
    with pytest.raises(ValueError):
        server.validate_permission_profile({"allowed_senders": "alice"})  # 须为列表
    with pytest.raises(ValueError):
        server.validate_permission_profile({"unknown_field": 1})  # 不接收未知字段


def test_permission_store_set_get_list():
    store = server.PermissionStore()
    assert store.get("default/fe-a") is None
    profile = {"allowed_senders": ["x"], "trust_map": {}, "inbound_mode": "readonly"}
    store.set("default/fe-a", profile)
    assert store.get("default/fe-a")["allowed_senders"] == ["x"]
    assert "updated_at" in store.get("default/fe-a")
    assert [p["identity"] for p in store.list()] == ["default/fe-a"]
    # set 存副本：外部改动不影响库内档案
    profile["allowed_senders"].append("y")
    assert store.get("default/fe-a")["allowed_senders"] == ["x"]


def test_build_metric_summary_aggregates():
    snap = {
        "ns/a": {"metrics": {"injected_ok": 2, "injected_fail": 1, "dropped": 1,
                             "deduped": 0, "queued": 0, "senders": 3, "uptime_s": 10},
                 "report_count": 4},
        "ns/b": {"metrics": {"injected_ok": 5, "injected_fail": 0, "dropped": 2,
                             "deduped": 1, "queued": 1, "senders": 1, "uptime_s": 99},
                 "report_count": 2},
        "ns/bad": {"metrics": "not-a-dict"},  # 非法条目跳过
    }
    s = server.build_metric_summary(snap)
    assert s["daemon_count"] == 2
    assert s["totals"] == {"injected_ok": 7, "injected_fail": 1, "dropped": 3,
                           "deduped": 1, "queued": 1}
    assert s["total_senders"] == 4


# ─── 路由层（TestClient 走真实 app） ──────────────────────────────────────────


def _client():
    # lifespan 会起 metric 采集连接；测试环境 broker 不可达时 paho 后台重连不阻塞
    return TestClient(server.app)


def test_api_namespaces_list_and_declare():
    with _client() as client:
        client.post("/api/console/namespaces", json={"name": "prodx"})
        r = client.get("/api/console/namespaces")
        assert r.status_code == 200
        names = [n["name"] for n in r.json()["namespaces"]]
        assert "prodx" in names
        # 重复声明幂等
        r2 = client.post("/api/console/namespaces", json={"name": "prodx"})
        assert r2.status_code == 200
        # 非法 ns 名 400
        assert client.post("/api/console/namespaces", json={"name": "a/b"}).status_code == 400


def test_api_identities_search():
    with _client() as client:
        # 通过指标上报注入一个 daemon 身份（直接写 store，模拟 TASK-19 采集）
        server._metrics_store.update("webtest/demo-daemon", {"injected_ok": 1}, "t")
        r = client.get("/api/console/identities", params={"q": "demo-daemon"})
        assert r.status_code == 200
        assert any(i["identity"] == "webtest/demo-daemon" for i in r.json()["identities"])


def test_api_permissions_put_get_and_control_distribution():
    with _client() as client:
        body = {"allowed_senders": ["default/alice"], "inbound_mode": "readonly"}
        r = client.put("/api/console/permissions/webtest/fe-a", json=body)
        assert r.status_code == 200
        data = r.json()
        assert data["profile"]["allowed_senders"] == ["default/alice"]
        assert "distributed" in data  # control 下发结果（broker 不可达时 False）

        r2 = client.get("/api/console/permissions")
        assert any(p["identity"] == "webtest/fe-a" for p in r2.json()["profiles"])

        r3 = client.get("/api/console/permissions/webtest/fe-a")
        assert r3.status_code == 200
        assert r3.json()["profile"]["inbound_mode"] == "readonly"

        # 未存档身份 404；非法档案 400
        assert client.get("/api/console/permissions/ns/nope").status_code == 404
        assert client.put("/api/console/permissions/webtest/fe-a",
                          json={"inbound_mode": "open"}).status_code == 400


def test_distribute_permission_waits_for_puback():
    """下发须等 PUBACK 确认（wait_for_publish），未送达返回 False 而非只看 rc"""

    class FakeMsgInfo:
        def __init__(self, flag):
            self._flag = flag

        def wait_for_publish(self, timeout=None):
            self._flag.append("waited")

        def is_published(self):
            return "acked" in self._flag

    class FakeClient:
        def __init__(self):
            self.published = []

        def is_connected(self):
            return True

        def publish(self, topic, payload, qos=1):
            self.published.append((topic, payload, qos))
            return FakeMsgInfo(self._flag)

    ok = FakeClient(); ok._flag = ["acked"]
    server._metric_client = ok
    try:
        assert server.distribute_permission_update("ns/a", {"inbound_mode": "readonly"}) is True
        topic, payload, qos = ok.published[0]
        assert topic == "/phnix/ai/channel/ns/a/message" and qos == 1
        import json as _json
        msg = _json.loads(payload)
        assert msg["type"] == "control" and msg["kind"] == "config_update"
        assert msg["config"]["inbound_mode"] == "readonly"

        bad = FakeClient(); bad._flag = []  # wait_for_publish 后仍未确认
        server._metric_client = bad
        assert server.distribute_permission_update("ns/a", {"inbound_mode": "readonly"}) is False
    finally:
        server._metric_client = None


def test_metric_client_publish_delivers_end_to_end():
    """真机级单测（需本地 broker，无 broker 时 skip）：paho publish 后独立订阅者
    应能收到（防 PUBACK 已到但消息未投递的静默丢失回归）"""
    import os
    import time
    import paho.mqtt.client as mqtt2

    host = os.getenv("MQTT_BROKER_HOST", "127.0.0.1")
    port = int(os.getenv("MQTT_BROKER_PORT", "18830"))

    received = []
    sub = mqtt2.Client(client_id="pytest-metric-sub", protocol=mqtt2.MQTTv311,
                       callback_api_version=mqtt2.CallbackAPIVersion.VERSION2)
    sub.on_message = lambda c, u, m: received.append((m.topic, m.payload.decode("utf-8")))
    try:
        sub.connect(host, port, keepalive=30)
    except Exception:
        import pytest
        pytest.skip("本地 broker 不可达，跳过端到端验证")
    sub.subscribe("/phnix/ai/metric/#", qos=1)
    sub.loop_start()
    time.sleep(1.0)

    pub = mqtt2.Client(client_id="pytest-metric-pub", protocol=mqtt2.MQTTv311,
                       callback_api_version=mqtt2.CallbackAPIVersion.VERSION2)
    pub.connect(host, port, keepalive=30)
    pub.loop_start()
    info = pub.publish("/phnix/ai/metric/pytest/x", '{"type":"metric"}', qos=1)
    info.wait_for_publish(timeout=5.0)
    assert info.is_published()
    time.sleep(1.5)
    sub.loop_stop(); sub.disconnect()
    pub.loop_stop(); pub.disconnect()
    assert any(t == "/phnix/ai/metric/pytest/x" for t, _ in received), \
        f"PUBACK 已到但订阅者未收到（broker={host}:{port}）"


def test_api_metrics_and_summary():
    with _client() as client:
        server._metrics_store.update("webtest/demo-daemon",
                                     {"injected_ok": 3, "dropped": 1}, "t")
        r = client.get("/api/console/metrics")
        assert r.status_code == 200
        data = r.json()
        assert "webtest/demo-daemon" in data["daemons"]
        assert "overview" in data  # 在线/注册/消息数/命名空间概览

        r2 = client.get("/api/console/metrics/summary")
        assert r2.status_code == 200
        s = r2.json()
        assert s["totals"]["injected_ok"] >= 3
        assert s["daemon_count"] >= 1
