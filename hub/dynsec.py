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


def ns_role_payload(ns_id: str) -> dict:
    """一个 ns 的角色：channel 读写 + metric 写。"""
    return {
        "rolename": group_name(ns_id),
        "acl": [
            {"topic": f"/agentbus/ai/channel/{ns_id}/#", "access": "readwrite", "allow": True, "priority": 10},
            {"topic": f"/agentbus/ai/metric/{ns_id}/#", "access": "write", "allow": True, "priority": 11},
        ],
    }


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
            self._publish(CONTROL_TOPIC, json.dumps(command))
            try:
                resp = self._responses.get(timeout=timeout)
            except queue.Empty:
                raise DynsecError(f"dynsec timeout: {command.get('command')}")
            errors = resp.get("errors")
            if errors:
                msg = "; ".join(e.get("error", str(e)) for e in errors)
                raise DynsecError(f"dynsec error: {msg}")
            return resp.get("data", {})

    def _drain(self) -> None:
        while not self._responses.empty():
            try:
                self._responses.get_nowait()
            except queue.Empty:
                break

    # ---- 业务命令封装 ----
    def create_client(self, username: str, password: str) -> None:
        self.execute({"command": "createClient", "clients": [{"username": username, "password": password}]})

    def delete_client(self, username: str) -> None:
        self.execute({"command": "deleteClient", "clients": [{"username": username}]})

    def set_client_password(self, username: str, password: str) -> None:
        self.execute({"command": "setClientPassword", "clients": [{"username": username, "password": password}]})

    def create_ns_group(self, ns_id: str) -> None:
        self.execute({"command": "createRole", "roles": [ns_role_payload(ns_id)]})
        self.execute({"command": "createGroup",
                      "groups": [{"groupname": group_name(ns_id), "roles": [{"rolename": group_name(ns_id)}]}]})

    def delete_ns_group(self, ns_id: str) -> None:
        self.execute({"command": "deleteGroup", "groups": [{"groupname": group_name(ns_id)}]})
        self.execute({"command": "deleteRole", "roles": [{"rolename": group_name(ns_id)}]})

    def add_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "addGroupClient",
                      "groupname": group_name(ns_id),
                      "clients": [{"username": username}]})

    def remove_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "removeGroupClient",
                      "groupname": group_name(ns_id),
                      "clients": [{"username": username}]})
