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


def _feed(c, data=None, errors=None, error=None, delay=0.05):
    time.sleep(delay)
    entry = {"command": "noop"}
    if data is not None:
        entry["data"] = data
    if errors is not None:
        entry["errors"] = errors
    if error is not None:
        entry["error"] = error
    # 插件实际响应结构：{"responses": [{"command", "data"?, "error"?/"errors"?}]}
    c.on_response(json.dumps({"responses": [entry]}).encode("utf-8"))


def test_create_client_command_flat(client):
    # 实测：参数平铺在命令对象上，包裹在 {"commands": [...]} 数组中
    c, bus = client
    t = threading.Thread(target=_feed, args=(c,))
    t.start()
    c.create_client("u1", "p1")
    t.join()
    topic, payload = bus.published[0]
    assert topic == dynsec.CONTROL_TOPIC
    assert payload == {"commands": [{"command": "createClient", "username": "u1", "password": "p1"}]}


def test_ns_group_commands_flat(client):
    c, bus = client
    # create_ns_group 实测下发：1 createRole + N addRoleACL + 1 createGroup
    n_acl = len(dynsec.ns_acl_entries("pay"))
    total = 1 + n_acl + 1

    def feedn():
        for _ in range(total):
            time.sleep(0.03)
            c.on_response(json.dumps({"responses": [{"command": "ok"}]}).encode())
    t = threading.Thread(target=feedn)
    t.start()
    c.create_ns_group("pay")
    t.join()
    cmds = [bus.published[i][1]["commands"][0] for i in range(total)]
    assert cmds[0] == {"command": "createRole", "rolename": "ns-pay"}
    # 中间 N 条均为 addRoleACL，带 acltype/topic
    for cmd, entry in zip(cmds[1:1 + n_acl], dynsec.ns_acl_entries("pay")):
        assert cmd["command"] == "addRoleACL" and cmd["rolename"] == "ns-pay"
        assert cmd["acltype"] == entry["acltype"] and cmd["topic"] == entry["topic"]
    assert cmds[-1]["command"] == "createGroup" and cmds[-1]["groupname"] == "ns-pay"
    assert cmds[-1]["roles"] == [{"rolename": "ns-pay"}]


def test_add_group_client_flat(client):
    c, bus = client
    t = threading.Thread(target=_feed, args=(c,))
    t.start()
    c.add_group_client("pay", "bob")
    t.join()
    assert bus.published[0][1]["commands"][0] == {
        "command": "addGroupClient", "groupname": "ns-pay", "username": "bob"}


def test_singular_error_raises(client):
    # 实测：单命令失败时插件返回单数字段 "error"（字符串）
    c, _ = client
    t = threading.Thread(target=_feed, args=(c,), kwargs={"error": "Invalid/missing username"})
    t.start()
    with pytest.raises(dynsec.DynsecError, match="Invalid/missing username"):
        c.create_client("", "p")
    t.join()


def test_plural_errors_raise(client):
    c, _ = client
    t = threading.Thread(target=_feed, args=(c, None, [{"error": "Client already exists"}]))
    t.start()
    with pytest.raises(dynsec.DynsecError, match="already exists"):
        c.execute({"command": "createClient", "username": "u1"})
    t.join()


def test_timeout(client):
    c, _ = client
    with pytest.raises(dynsec.DynsecError, match="timeout"):
        c.execute({"command": "listClients"}, timeout=0.2)


def test_ns_acl_entries():
    # 实测：ACL 条目用 acltype 字段；channel 读/写 + metric 写 + status 写（presence，0.2.10）
    entries = dynsec.ns_acl_entries("pay")
    assert dynsec.group_name("pay") == "ns-pay"
    topics = {e["topic"] for e in entries}
    assert "/agentbus/ai/channel/pay/#" in topics
    assert "/agentbus/ai/metric/pay/#" in topics
    assert "/agentbus/ai/status/pay/#" in topics
    # status 仅允许 publish（daemon 发 presence；订阅是 hub 侧 hub-admin 全量权限）
    st = [e for e in entries if e["topic"] == "/agentbus/ai/status/pay/#"]
    assert len(st) == 1 and st[0]["acltype"] == "publishClientSend"
    assert all("acltype" in e and "access" not in e for e in entries)
    # channel 至少含发布与订阅两类 acltype
    ch_types = {e["acltype"] for e in entries if e["topic"] == "/agentbus/ai/channel/pay/#"}
    assert "publishClientSend" in ch_types and "subscribePattern" in ch_types
