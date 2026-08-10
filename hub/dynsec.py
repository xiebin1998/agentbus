"""mosquitto dynamic-security 插件客户端：命令构造 + 串行请求-响应执行器。"""
import json
import queue
import threading

CONTROL_TOPIC = "$CONTROL/dynamic-security/v1"
RESPONSE_TOPIC = "$CONTROL/dynamic-security/v1/response"


class DynsecError(RuntimeError):
    pass


def group_name(ns_id: str) -> str:
    return f"ns-{ns_id}"


def ns_acl_entries(ns_id: str) -> list:
    """一个 ns 的 ACL 条目：channel 读写 + metric 写。

    实测：createRole 不采纳内联 acl，须用 addRoleACL 逐条下发；
    ACL 条目字段为 acltype（非 access）。
    """
    ch = f"/agentbus/ai/channel/{ns_id}/#"
    mt = f"/agentbus/ai/metric/{ns_id}/#"
    return [
        {"acltype": "publishClientSend", "topic": ch, "allow": True, "priority": 10},
        {"acltype": "publishClientReceive", "topic": ch, "allow": True, "priority": 10},
        {"acltype": "subscribePattern", "topic": ch, "allow": True, "priority": 10},
        {"acltype": "unsubscribePattern", "topic": ch, "allow": True, "priority": 10},
        {"acltype": "publishClientSend", "topic": mt, "allow": True, "priority": 11},
    ]


class DynsecClient:
    """publish_fn(topic, payload_str) 由 server.py 注入共享 MQTT 连接的发布函数。"""

    def __init__(self, publish_fn):
        self._publish = publish_fn
        self._responses: queue.Queue = queue.Queue()
        self._lock = threading.Lock()  # 串行：一次一条命令在途

    def on_response(self, payload: bytes) -> None:
        """共享连接 on_message 里把 RESPONSE_TOPIC 的消息转进来。"""
        try:
            self._responses.put_nowait(json.loads(payload))
        except (ValueError, TypeError):
            pass

    def execute(self, command: dict, timeout: float = 5.0) -> dict:
        with self._lock:
            self._drain()
            # 插件只认 {"commands": [...]} 数组格式；响应为 {"responses": [...]}
            self._publish(CONTROL_TOPIC, json.dumps({"commands": [command]}))
            try:
                resp = self._responses.get(timeout=timeout)
            except queue.Empty:
                raise DynsecError(f"dynsec timeout: {command.get('command')}")
            entries = resp.get("responses")
            if entries is None:
                # 旧格式/异常响应兜底：顶层也可能带 errors
                if resp.get("errors"):
                    raise DynsecError("; ".join(e.get("error", str(e)) for e in resp["errors"]))
                return resp.get("data", {})
            if not entries:
                raise DynsecError(f"dynsec empty response: {command.get('command')}")
            entry = entries[0]
            # 实测：单命令失败时插件用单数字段 "error"（字符串），而非复数 "errors" 数组
            error = entry.get("error")
            if error:
                raise DynsecError(f"dynsec error: {error}")
            errors = entry.get("errors")
            if errors:
                msg = "; ".join(e.get("error", str(e)) for e in errors)
                raise DynsecError(f"dynsec error: {msg}")
            return entry.get("data", {})

    def _drain(self) -> None:
        while not self._responses.empty():
            try:
                self._responses.get_nowait()
            except queue.Empty:
                break

    # ---- 业务命令封装（实测：参数平铺在命令对象上，非嵌套数组）----
    def create_client(self, username: str, password: str) -> None:
        self.execute({"command": "createClient", "username": username, "password": password})

    def delete_client(self, username: str) -> None:
        self.execute({"command": "deleteClient", "username": username})

    def set_client_password(self, username: str, password: str) -> None:
        self.execute({"command": "setClientPassword", "username": username, "password": password})

    def create_ns_group(self, ns_id: str) -> None:
        rolename = group_name(ns_id)
        self.execute({"command": "createRole", "rolename": rolename})
        # 实测：createRole 不采纳内联 acl，须用 addRoleACL 逐条追加
        for entry in ns_acl_entries(ns_id):
            self.execute({"command": "addRoleACL", "rolename": rolename, **entry})
        self.execute({"command": "createGroup",
                      "groupname": rolename,
                      "roles": [{"rolename": rolename}]})

    def delete_ns_group(self, ns_id: str) -> None:
        self.execute({"command": "deleteGroup", "groupname": group_name(ns_id)})
        self.execute({"command": "deleteRole", "rolename": group_name(ns_id)})

    def add_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "addGroupClient",
                      "groupname": group_name(ns_id),
                      "username": username})

    def remove_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "removeGroupClient",
                      "groupname": group_name(ns_id),
                      "username": username})
