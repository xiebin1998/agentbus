import json
import threading
import time

import pytest

from hub import dynsec


class FakeBus:
    """记录 publish，响应由测试线程喂回 on_response。"""

    def __init__(self):
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, json.loads(payload)))


@pytest.fixture()
def client():
    bus = FakeBus()
    c = dynsec.DynsecClient(bus.publish)
    return c, bus


def _feed(c, data=None, errors=None, delay=0.05):
    time.sleep(delay)
    resp = {"data": data or {}}
    if errors is not None:
        resp["errors"] = errors
    c.on_response(json.dumps(resp).encode("utf-8"))


def test_create_client_command(client):
    c, bus = client
    t = threading.Thread(target=_feed, args=(c,))
    t.start()
    c.execute({"command": "createClient", "clients": [{"username": "u1", "password": "p1"}]})
    t.join()
    topic, payload = bus.published[0]
    assert topic == dynsec.CONTROL_TOPIC
    assert payload["command"] == "createClient"


def test_errors_raise(client):
    c, _ = client
    t = threading.Thread(target=_feed, args=(c, None, [{"error": "Client already exists"}]))
    t.start()
    with pytest.raises(dynsec.DynsecError, match="already exists"):
        c.execute({"command": "createClient", "clients": [{"username": "u1"}]})
    t.join()


def test_timeout(client):
    c, _ = client
    with pytest.raises(dynsec.DynsecError, match="timeout"):
        c.execute({"command": "listClients"}, timeout=0.2)


def test_ns_acl_payloads():
    role = dynsec.ns_role_payload("pay")
    assert role["rolename"] == "ns-pay"
    patterns = [a["topic"] for a in role["acl"]]
    assert "/agentbus/ai/channel/pay/#" in patterns
    assert "/agentbus/ai/metric/pay/#" in patterns
    assert dynsec.group_name("pay") == "ns-pay"
