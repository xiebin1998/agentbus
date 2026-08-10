"""
MCP MQTT Bridge Server — Agent 实时通信版
===========================================
支持多个 Agent 互相实时通信，兼容 qwenpaw。

消息格式（兼容 qwenpaw）：
{
    "id": "msg-abc123",
    "from": "qwenpaw",                    // 发送方
    "redirect_client_id": "qwenpaw",      // 兼容 qwenpaw 字段
    "to": "hermes",
    "text": "消息内容",
    "type": "text",
    "timestamp": "2025-01-15T10:30:00Z"
}

Topic:
    /phnix/ai/channel/{client_id}/message

MCP 工具：
├── register_agent(name, description, capabilities)  注册 Agent
├── update_agent(capabilities)                        更新能力
├── send_message(text, to, type)                      发送消息
├── get_agent_info(client_id)                         查询 Agent 信息
├── find_agents_by_capability(capability)             按能力查找
├── list_agents()                                     列出所有 Agent
├── ack_message(id)                                   确认收到
└── get_status()                                      获取状态
"""

import asyncio
import json
import logging
import os
import re
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional, Dict, List, Union

import paho.mqtt.client as mqtt
from mcp.server import Server
from mcp.server.session import ServerSession
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent, ToolAnnotations
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from pathlib import Path

# ─── 日志配置 ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("agentbus-hub")

# ─── 配置 ────────────────────────────────────────────────────────────────────
MQTT_BROKER_HOST = os.getenv("MQTT_BROKER_HOST", "localhost")
MQTT_BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_USE_TLS = os.getenv("MQTT_USE_TLS", "false").lower() == "true"
# TASK-25：自签 CA 证书路径（TLS 时作为信任锚；空则信任系统证书链）
MQTT_CA_CERTS = os.getenv("MQTT_CA_CERTS", "")
MCP_HOST = os.getenv("MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.getenv("MCP_PORT", "8000"))

# ─── Topic ────────────────────────────────────────────────────────────────────
TOPIC_MESSAGE = "/phnix/ai/channel/{client_id}/message"

# TASK-19：daemon 指标上报通道（与消息 topic 平行命名，hub 通配订阅汇总）
TOPIC_METRIC_PREFIX = "/phnix/ai/metric/"
TOPIC_METRIC_WILDCARD = "/phnix/ai/metric/#"

# TASK-24：共享连接通配订阅（架构 11.8 演进方案 2）：flat + ns 两条 message 通配
TOPIC_MESSAGE_PREFIX = "/phnix/ai/channel/"
TOPIC_MESSAGE_WILDCARD_FLAT = "/phnix/ai/channel/+/message"
TOPIC_MESSAGE_WILDCARD_NS = "/phnix/ai/channel/+/+/message"

# 消息体上限（架构 11.8 缺陷 5）：防止异常大包占满 broker 与内存
MAX_TEXT_BYTES = 64 * 1024


# ─── 纯逻辑层（TASK-01 提取，可单测；行为规则见架构 3.1 兼容规则） ────────────────

def build_sub_topic(client_id: str, ns: Optional[str] = None) -> str:
    """构造订阅/推送 topic。ns=None → 旧 flat topic（兼容存量）；显式 ns → ns topic"""
    if ns is None:
        return TOPIC_MESSAGE.format(client_id=client_id)
    return f"/phnix/ai/channel/{ns}/{client_id}/message"


def resolve_target(t: str) -> tuple:
    """解析单个目标 → (ns_or_None, client_id, tool_or_None)。

    支持 "cid" / "ns/cid" / "cid@tool" / "ns/cid@tool"；
    无 ns/ 前缀时 ns=None，由 build_pub_topics 按发件人 ns 解释。
    @tool 后缀仅供 daemon 选择承接工具，不进 topic。
    """
    s = (t or "").strip()
    if not s:
        raise ValueError("空的目标")
    ns = None
    if "/" in s:
        ns, s = s.split("/", 1)
    tool = None
    if "@" in s:
        s, tool = s.split("@", 1)
    cid = s.strip()
    if not cid or (ns is not None and not ns.strip()):
        raise ValueError(f"非法目标格式: {t!r}")
    return (ns.strip() if ns else ns), cid, tool


def split_targets(to: Union[str, List[str]]) -> List[str]:
    """将 to（字符串/逗号分隔/列表）规整为目标字符串列表"""
    if isinstance(to, str):
        items = [s.strip() for s in to.split(",") if s.strip()]
    elif isinstance(to, list):
        items = [s.strip() for s in to if isinstance(s, str) and s.strip()]
    else:
        raise ValueError(f"不支持的 to 类型: {type(to).__name__}")
    if not items:
        raise ValueError("未指定消息接收方")
    return items


def build_pub_topics(to: Union[str, List[str]], sender_ns: Optional[str]) -> List[str]:
    """将 to（字符串/逗号分隔/列表）展开为 publish topic 列表，去重保序。

    目标无 ns/ 前缀时继承发件人 ns（sender_ns=None 时为 flat，兼容存量）。
    """
    topics: List[str] = []
    seen = set()
    for item in split_targets(to):
        ns, cid, _tool = resolve_target(item)
        topic = build_sub_topic(cid, ns if ns is not None else sender_ns)
        if topic not in seen:
            seen.add(topic)
            topics.append(topic)
    return topics


def check_text_size(text: Optional[str]) -> None:
    """消息体上限校验，超限抛 ValueError（TASK-02 接入调用点）"""
    if text is not None and len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError(f"消息体超过 {MAX_TEXT_BYTES} 字节上限")


def parse_metric_topic(topic: str) -> Optional[str]:
    """TASK-19：metric topic → daemon 身份。/phnix/ai/metric/<ns>/<cid> → "ns/cid"；
    flat 兼容 /phnix/ai/metric/<cid> → "cid"；非法/超段返回 None"""
    if not topic or not topic.startswith(TOPIC_METRIC_PREFIX):
        return None
    parts = topic[len(TOPIC_METRIC_PREFIX):].split("/")
    if len(parts) == 1 and parts[0]:
        return parts[0]
    if len(parts) == 2 and parts[0] and parts[1]:
        return f"{parts[0]}/{parts[1]}"
    return None


def parse_message_topic(topic: str) -> Optional[tuple]:
    """TASK-24：message topic → (ns_or_None, client_id)。共享连接按 topic 路由的第一步：
    flat /phnix/ai/channel/<cid>/message → (None, cid)；
    ns /phnix/ai/channel/<ns>/<cid>/message → (ns, cid)；其余（含 metric）返回 None"""
    if (not topic or not topic.startswith(TOPIC_MESSAGE_PREFIX)
            or not topic.endswith("/message")):
        return None
    parts = topic[len(TOPIC_MESSAGE_PREFIX):-len("/message")].split("/")
    if len(parts) == 1 and parts[0]:
        return (None, parts[0])
    if len(parts) == 2 and parts[0] and parts[1]:
        return (parts[0], parts[1])
    return None


def route_message_key(topic: str) -> Optional[str]:
    """TASK-24：message topic → 会话表键（session_key 语义）；非法返回 None"""
    parsed = parse_message_topic(topic)
    if parsed is None:
        return None
    ns, cid = parsed
    return session_key(cid, ns)


class MetricsStore:
    """TASK-19：各 daemon 最新指标汇总（指标以最近一次上报为准，报告次数累加）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}

    def update(self, identity: str, metrics: Any, timestamp: Optional[str]) -> None:
        if not isinstance(metrics, dict):
            return
        with self._lock:
            entry = self._data.get(identity, {"report_count": 0})
            entry["metrics"] = metrics
            entry["last_seen"] = timestamp
            entry["report_count"] += 1
            self._data[identity] = entry

    def snapshot(self) -> Dict[str, dict]:
        with self._lock:
            return {k: dict(v) for k, v in self._data.items()}


# ─── Web 控制台后端 API 纯逻辑层（TASK-20，供 /api/console/* 路由复用） ──────────

class NamespaceRegistry:
    """控制台显式声明的命名空间（ns 本体由 topic 路径天然隔离，此处仅登记清单）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}

    def declare(self, name: str) -> Optional[dict]:
        name = (name or "").strip()
        if not name or "/" in name:
            return None
        with self._lock:
            if name not in self._data:
                self._data[name] = {
                    "name": name,
                    "declared": True,
                    "declared_at": datetime.now(timezone.utc).isoformat(),
                }
            return dict(self._data[name])

    def list(self) -> List[dict]:
        with self._lock:
            return [dict(v) for v in self._data.values()]


# ─── TASK-26：账号/团队管理（一团队一账号 + topic 前缀 ACL） ─────────────

_TEAM_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")  # 同 ns 命名规则（架构 3.1.1）


def team_broker_user(team_name: str) -> str:
    """一团队一账号：broker 账号名 = team-<团队名>"""
    return f"team-{team_name}"


def render_broker_acl(hub_user: str, teams: List[dict]) -> str:
    """渲染 mosquitto ACL 文件：hub 账号全量；团队账号仅本 ns
    channel readwrite + metric write（跨团队 publish 被 broker 拒，验收项）"""
    lines = [
        "# AgentBus broker ACL（TASK-26 一团队一账号；sync-broker-acl 脚本生成，勿手改）",
        "# hub 共享连接：全量权限",
        f"user {hub_user}",
        "topic readwrite #",
        "",
    ]
    for t in teams:
        ns = t["name"]
        lines += [
            f"user {team_broker_user(ns)}",
            f"topic readwrite /phnix/ai/channel/{ns}/#",
            f"topic write /phnix/ai/metric/{ns}/#",
            "",
        ]
    return "\n".join(lines)


class TeamStore:
    """团队登记（团队 ↔ ns 绑定；内存态，与 ns/权限登记一致）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}

    def create(self, name: str, members: Optional[List[str]] = None) -> Optional[dict]:
        name = (name or "").strip()
        if not _TEAM_NAME_RE.match(name):
            return None
        with self._lock:
            if name in self._data:
                return None
            entry = {
                "name": name,
                "broker_user": team_broker_user(name),
                "members": [m.strip() for m in (members or [])
                            if isinstance(m, str) and m.strip()],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            self._data[name] = entry
            return dict(entry)

    def delete(self, name: str) -> bool:
        with self._lock:
            return self._data.pop(name, None) is not None

    def list(self) -> Dict[str, dict]:
        with self._lock:
            return {k: dict(v) for k, v in self._data.items()}


def _ns_of(key: str) -> str:
    """身份键 → 所属 ns；无 ns 前缀（flat 兼容）归入 flat"""
    return key.split("/", 1)[0] if "/" in key else "flat"


def collect_namespaces(session_keys, agent_keys, metric_keys, declared: List[dict]) -> List[dict]:
    """四路来源（在线会话/注册信息/daemon 指标/显式声明）合并为 ns 清单，按名称排序"""
    table: Dict[str, dict] = {}

    def slot(ns: str) -> dict:
        if ns not in table:
            table[ns] = {"name": ns, "online_agents": 0, "registered_agents": 0,
                         "daemon_count": 0, "declared": False}
        return table[ns]

    for key in session_keys:
        slot(_ns_of(key))["online_agents"] += 1
    for key in agent_keys:
        slot(_ns_of(key))["registered_agents"] += 1
    for key in metric_keys:
        slot(_ns_of(key))["daemon_count"] += 1
    for d in declared:
        entry = slot(d["name"])
        entry["declared"] = True
        entry["declared_at"] = d.get("declared_at")
    return [table[k] for k in sorted(table)]


def collect_identities(session_keys, agent_keys, metric_keys,
                       ns: Optional[str] = None, q: Optional[str] = None) -> List[dict]:
    """<ns>/<client_id> 身份清单：并集去重 + 三态标记（在线/已注册/有指标），支持 ns 过滤与子串检索"""
    sessions = set(session_keys)
    agents = set(agent_keys)
    metrics = set(metric_keys)
    result = []
    for key in sorted(sessions | agents | metrics):
        if ns is not None and _ns_of(key) != ns:
            continue
        if q and q.lower() not in key.lower():
            continue
        result.append({
            "identity": key,
            "ns": _ns_of(key),
            "client_id": key.split("/", 1)[1] if "/" in key else key,
            "online": key in sessions,
            "registered": key in agents,
            "has_metrics": key in metrics,
        })
    return result


# 权限档案契约与 daemon 配置对齐（config.ts：inbound_mode 只允许 readonly/full）
VALID_INBOUND_MODES = ("readonly", "full")
_PERMISSION_FIELDS = ("allowed_senders", "trust_map", "inbound_mode")


def validate_permission_profile(body: Any) -> dict:
    """校验并规整权限档案（allowed_senders/trust_map/inbound_mode）；缺省字段补默认值，非法抛 ValueError"""
    if not isinstance(body, dict):
        raise ValueError("权限档案须为对象")
    unknown = set(body) - set(_PERMISSION_FIELDS)
    if unknown:
        raise ValueError(f"未知字段: {sorted(unknown)}")

    senders = body.get("allowed_senders", [])
    if not isinstance(senders, list) or not all(isinstance(s, str) and s.strip() for s in senders):
        raise ValueError("allowed_senders 须为非空字符串列表")

    trust_map = body.get("trust_map", {})
    if not isinstance(trust_map, dict) or not all(
        isinstance(k, str) and isinstance(v, str) and v in VALID_INBOUND_MODES
        for k, v in trust_map.items()
    ):
        raise ValueError(f"trust_map 值只允许 {list(VALID_INBOUND_MODES)}")

    mode = body.get("inbound_mode", "readonly")
    if mode not in VALID_INBOUND_MODES:
        raise ValueError(f"inbound_mode 只允许 {list(VALID_INBOUND_MODES)}")

    return {"allowed_senders": [s.strip() for s in senders],
            "trust_map": dict(trust_map), "inbound_mode": mode}


class PermissionStore:
    """控制台权限档案库（内存，重启不持久；下发靠 control 消息通知 daemon）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}

    def set(self, identity: str, profile: dict) -> dict:
        with self._lock:
            entry = json.loads(json.dumps(profile))  # 深拷贝，防外部后续改动污染
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._data[identity] = entry
            return dict(entry)

    def get(self, identity: str) -> Optional[dict]:
        with self._lock:
            entry = self._data.get(identity)
            return dict(entry) if entry else None

    def list(self) -> List[dict]:
        with self._lock:
            return [dict(v, identity=k) for k, v in self._data.items()]


def build_metric_summary(snapshot: Dict[str, dict]) -> dict:
    """各 daemon 指标汇总：总量计数 + 在线 daemon 数 + 总会话发件人数（非法条目跳过）"""
    totals = {"injected_ok": 0, "injected_fail": 0, "dropped": 0, "deduped": 0, "queued": 0}
    daemon_count = 0
    total_senders = 0
    for entry in snapshot.values():
        metrics = entry.get("metrics") if isinstance(entry, dict) else None
        if not isinstance(metrics, dict):
            continue
        daemon_count += 1
        for k in totals:
            v = metrics.get(k)
            if isinstance(v, (int, float)):
                totals[k] += v
        senders = metrics.get("senders")
        if isinstance(senders, (int, float)):
            total_senders += senders
    return {"daemon_count": daemon_count, "totals": totals, "total_senders": total_senders}


def can_ack(stored: Optional[dict], caller: str) -> bool:
    """ack 归属校验（架构 11.8 缺陷 4）：仅发送方/接收方可标记已读"""
    if not stored:
        return False
    if stored.get("from") == caller:
        return True
    to = stored.get("to")
    if isinstance(to, list):
        return caller in to
    return to == caller


# ─── ns 接入与内存治理（TASK-02） ────────────────────────────────────────

# 消息存储容量与保留时长（架构 11.8 缺陷 1）
MESSAGE_STORE_MAX = 10000
MESSAGE_TTL_SECONDS = 24 * 3600


def normalize_ns(raw: Optional[str]) -> Optional[str]:
    """SSE ns 参数归一化：None/空串 → None（flat 兼容），其余去空白"""
    if raw is None:
        return None
    s = raw.strip()
    return s or None


def session_key(client_id: str, ns: Optional[str]) -> str:
    """会话/注册表键：未传 ns → 旧键（client_id）；显式 ns → <ns>/<client_id>"""
    if ns is None:
        return client_id
    return f"{ns}/{client_id}"


def store_message(store: dict, msg_id: str, payload: dict, max_len: int = MESSAGE_STORE_MAX) -> None:
    """存入消息并打时间戳；超容量时淘汰最旧（架构 11.8 缺陷 1）"""
    payload["_stored_at"] = datetime.now(timezone.utc)
    store[msg_id] = payload
    while len(store) > max_len:
        del store[next(iter(store))]


def sweep_messages(store: dict, now: datetime, ttl_seconds: int = MESSAGE_TTL_SECONDS) -> int:
    """清理 TTL 过期消息，返回清理条数"""
    expired = [
        mid for mid, p in store.items()
        if (now - p.get("_stored_at", now)).total_seconds() > ttl_seconds
    ]
    for mid in expired:
        del store[mid]
    return len(expired)


def filter_offline(targets: List[str], online_keys: set) -> tuple:
    """群发部分送达（架构 11.8 缺陷 7）：拆分为 (在线目标, 离线目标)，保序"""
    online = [t for t in targets if t in online_keys]
    offline = [t for t in targets if t not in online_keys]
    return online, offline


def plan_send_targets(targets: List[str], online_keys: set) -> tuple:
    """发送目标三态划分（TASK-13 冒烟，架构 5.5 机制 1）：
    SSE 会话表在 = 确认在线；不在 ≠ 离线，可能是纯 MQTT 直连（daemon 等），
    拒发会导致 hub 永远无法触达 daemon → 未知目标尽力发布。
    返回 (待发布目标, 未知在线状态目标)，均保序"""
    if not targets:
        raise ValueError("targets 不可为空")
    unknown = [t for t in targets if t not in online_keys]
    return list(targets), unknown


def resolve_agent_key(target: str, caller_ns: Optional[str]) -> str:
    """get_agent_info 键解析：带 ns/ 前缀直接用；否则继承调用方 ns"""
    if "/" in target:
        return target
    return session_key(target, caller_ns)


# ─── Agent 信息结构 ──────────────────────────────────────────────────────────

class AgentInfo:
    """Agent 注册信息"""
    
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.name: Optional[str] = None
        self.description: Optional[str] = None
        self.capabilities: List[str] = []
        self.metadata: Dict[str, Any] = {}
        self.registered = False
        self.registered_at: Optional[datetime] = None
        self.connected_at = datetime.now(timezone.utc)
        self.last_active: Optional[datetime] = None
    
    def register(self, name: str, description: str, capabilities: List[str], metadata: Dict = None):
        self.name = name
        self.description = description
        self.capabilities = capabilities
        self.metadata = metadata or {}
        self.registered = True
        self.registered_at = datetime.now(timezone.utc)
    
    def update(self, capabilities: List[str] = None, metadata: Dict = None):
        if capabilities:
            self.capabilities = capabilities
        if metadata:
            self.metadata.update(metadata)
        self.last_active = datetime.now(timezone.utc)
    
    def to_dict(self) -> dict:
        return {
            "client_id": self.client_id,
            "name": self.name,
            "description": self.description,
            "capabilities": self.capabilities,
            "metadata": self.metadata,
            "registered": self.registered,
            "registered_at": self.registered_at.isoformat() if self.registered_at else None,
            "connected_at": self.connected_at.isoformat(),
            "last_active": self.last_active.isoformat() if self.last_active else None,
        }


# ─── 全局状态 ────────────────────────────────────────────────────────────────

_sessions: Dict[str, "AgentSession"] = {}
_servers: Dict[str, Server] = {}
_messages: Dict[str, dict] = {}
_agent_info: Dict[str, AgentInfo] = {}

# TASK-19/24：daemon 指标汇总（全局单例，/health 与共享连接采集共享）
_metrics_store = MetricsStore()

# TASK-24：hub 唯一 MQTT 共享连接（架构 11.8 演进方案 2：线程数 N→1）
_shared_client: Optional[mqtt.Client] = None
_shared_ready = threading.Event()

# TASK-20：控制台全局状态（显式 ns 登记 + 权限档案库）
_ns_registry = NamespaceRegistry()
_permission_store = PermissionStore()


def _handle_metric_message(msg) -> None:
    """TASK-19 metric 消息入库（原 metric 连接 on_message 逻辑，TASK-24 并入共享连接路由）"""
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return
    if not isinstance(payload, dict) or payload.get("type") != "metric":
        return
    identity = parse_metric_topic(msg.topic)
    if not identity:
        return
    # payload.from 优先（daemon 自报身份），回退 topic 推导
    from_id = payload.get("from")
    if isinstance(from_id, str) and from_id.strip():
        identity = from_id.strip()
    _metrics_store.update(identity, payload.get("metrics"), payload.get("timestamp"))


def start_shared_client() -> None:
    """TASK-24：hub 唯一 MQTT 连接（架构 11.8 演进方案 2）——通配订阅 flat/ns 两条
    message topic 与 metric topic，按 topic 解析目标身份路由到对应会话；
    取消每 Agent 的 paho 客户端与 loop_start 线程（线程数 N→1）。
    broker 不可达时 paho 内部自动重连，不阻塞启动"""
    global _shared_client
    client = mqtt.Client(
        client_id=f"agentbus-hub-shared-{uuid.uuid4().hex[:8]}",
        protocol=mqtt.MQTTv311,
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    if MQTT_USE_TLS:
        client.tls_set(ca_certs=MQTT_CA_CERTS or None)

    def on_connect(c, userdata, flags, rc, properties=None):
        if rc == 0:
            c.subscribe([
                (TOPIC_MESSAGE_WILDCARD_FLAT, 2),
                (TOPIC_MESSAGE_WILDCARD_NS, 2),
                (TOPIC_METRIC_WILDCARD, 1),
            ])
            _shared_ready.set()
            logger.info(f"[hub-shared] subscribed to {TOPIC_MESSAGE_WILDCARD_FLAT}, "
                        f"{TOPIC_MESSAGE_WILDCARD_NS}, {TOPIC_METRIC_WILDCARD}")
        else:
            logger.error(f"[hub-shared] connect failed: rc={rc}")

    def on_disconnect(c, userdata, flags, rc, properties=None):
        _shared_ready.clear()
        logger.warning(f"[hub-shared] MQTT disconnected (rc={rc})")

    def on_message(c, userdata, msg):
        if msg.topic.startswith(TOPIC_METRIC_PREFIX):
            _handle_metric_message(msg)
            return
        key = route_message_key(msg.topic)
        if key is None:
            return
        session = _sessions.get(key)
        if session is None:
            return
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.error(f"[{key}] Invalid JSON on {msg.topic}")
            return
        if not isinstance(payload, dict):
            return
        sender = payload.get("redirect_client_id") or payload.get("from", "?")
        logger.info(f"[{key}] Received from [{sender}]: {str(payload.get('text', ''))[:50]}")
        asyncio.run_coroutine_threadsafe(session._push_to_mcp(payload), session.loop)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(MQTT_BROKER_HOST, MQTT_BROKER_PORT)
    client.loop_start()
    _shared_client = client


def wait_shared_ready(timeout: float = 5.0) -> bool:
    """阻塞等待共享连接建连 + 通配订阅就绪"""
    return _shared_ready.wait(timeout)


def stop_shared_client() -> None:
    global _shared_client
    if _shared_client is not None:
        _shared_client.loop_stop()
        _shared_client.disconnect()
        _shared_client = None
    _shared_ready.clear()


def publish_shared(topic: str, payload: str, qos: int = 2):
    """统一发布入口（TASK-24）：共享连接未启动返回 False，否则转发给 paho（返回 info）"""
    if _shared_client is None:
        return False
    return _shared_client.publish(topic, payload, qos=qos)


def distribute_permission_update(identity: str, profile: dict) -> bool:
    """TASK-20：权限档案下发——经共享连接向目标 daemon 的消息 topic 发 type=control
    config_update 通知（control 短路不触发回合，架构 3.3）；daemon 侧落地应用为后续演进，
    未送达返回 False（档案已在 hub 侧保存）。送达判定以 wait_for_publish 等到
    PUBACK 为准，不能只看 publish 返回码（真机冒烟实测：rc 成功但消息未上总线）"""
    if _shared_client is None or not _shared_client.is_connected():
        return False
    ns, cid = (identity.split("/", 1) + [None])[:2] if "/" in identity else (None, identity)
    topic = build_sub_topic(cid, ns)
    payload = json.dumps({
        "id": f"cfg-{uuid.uuid4().hex[:12]}",
        "type": "control",
        "from": "hub-console",
        "to": identity,
        "kind": "config_update",
        "config": profile,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False)
    try:
        info = _shared_client.publish(topic, payload, qos=1)
        info.wait_for_publish(timeout=5.0)
        return info.is_published()
    except Exception as e:
        logger.warning(f"[console] 权限下发失败 {identity}: {e}")
        return False


# ─── Agent Session ───────────────────────────────────────────────────────────

class AgentSession:
    """单个 Agent 的会话。

    TASK-24 起为共享连接模型（架构 11.8 演进方案 2）：不再自建 paho 客户端与
    loop_start 线程；入站消息由 hub 共享连接按 topic 路由进来，出站统一走
    publish_shared。就绪门控跟随共享连接的通配订阅就绪（TASK-13 语义不变）。
    """

    def __init__(self, client_id: str, event_loop: asyncio.AbstractEventLoop, ns: Optional[str] = None):
        self.client_id = client_id
        self.ns = ns
        self.key = session_key(client_id, ns)
        self.loop = event_loop
        self.mcp_server: Optional[Server] = None
        self.mcp_session: Optional[ServerSession] = None
        self.sub_topic = build_sub_topic(client_id, ns)

        self.info = AgentInfo(self.key)
        _agent_info[self.key] = self.info

    @property
    def connected(self) -> bool:
        """mqtt_connected 语义（list_agents/get_status 用）：共享连接在线即全员可达"""
        return _shared_client is not None and _shared_client.is_connected()

    def is_registered(self) -> bool:
        return self.info.registered

    def start(self):
        """会话上线：登记入路由表（共享连接按 topic 路由的前提）；
        broker 连接由 lifespan 统一建立，会话侧不再自建"""
        _sessions[self.key] = self

    def is_mqtt_ready(self) -> bool:
        return _shared_ready.is_set()

    def wait_ready(self, timeout: float = 5.0) -> bool:
        """阻塞等待共享连接建连 + 通配订阅就绪（供调用方在线程中等待）"""
        return _shared_ready.wait(timeout)
    
    async def _push_to_mcp(self, payload: dict):
        session = self.mcp_session
        if session is None or getattr(session.write_stream, "_closed", False):
            logger.warning(f"[{self.client_id}] MCP session not ready, message dropped")
            return
        
        try:
            # mcp 1.2.0：通知需经会话发送，用标准日志通知（method: notifications/message）
            await session.send_log_message(level="info", data=payload, logger="mqtt")
            logger.info(f"[{self.client_id}] Pushed to MCP client ✓")
        except Exception as e:
            logger.error(f"[{self.client_id}] Push failed: {e}")
    
    def register(self, name: str, description: str, capabilities: List[str], metadata: Dict = None) -> dict:
        self.info.register(name, description, capabilities, metadata)
        logger.info(f"[{self.client_id}] Agent registered: {name}")
        return {
            "status": "registered",
            "client_id": self.client_id,
            "name": name,
            "capabilities": capabilities,
        }
    
    def send_message(self, text: str, to: Union[str, List[str]], msg_type: str = "text") -> dict:
        """发送消息给目标 Agent（支持多人）"""
        msg_id = f"msg-{uuid.uuid4().hex[:12]}"
        timestamp = datetime.now(timezone.utc).isoformat()
        
        # ★ 构建消息格式（兼容 qwenpaw）★
        # from 用总线身份 self.key（ns 客户端为 <ns>/<cid>，flat 客户端即 cid，兼容不变）
        payload = {
            "id": msg_id,
            "from": self.key,                          # 标准字段
            "redirect_client_id": self.key,            # 兼容 qwenpaw
            "to": to,
            "text": text,
            "type": msg_type,
            "timestamp": timestamp,
        }
        
        sent_to = split_targets(to)
        pub_topics = build_pub_topics(to, self.ns)
        message_json = json.dumps(payload, ensure_ascii=False)
        if _shared_client is None:
            raise RuntimeError("共享 MQTT 连接未启动（hub lifespan 未生效），无法发送")
        for pub_topic in pub_topics:
            _shared_client.publish(pub_topic, message_json, qos=2)
            logger.info(f"[{self.client_id}] Published to {pub_topic}")
        
        self.info.last_active = datetime.now(timezone.utc)
        # 容量/TTL 治理（11.8 缺陷 1）：存入时顺手清过期，避免额外定时任务
        sweep_messages(_messages, datetime.now(timezone.utc))
        store_message(_messages, msg_id, payload)
        
        return {
            "status": "sent",
            "id": msg_id,
            "to": sent_to,
        }
    
    def close(self):
        # TASK-24：会话下线从路由表移除；共享连接由 lifespan 统一停止
        _sessions.pop(self.key, None)
        logger.info(f"[{self.client_id}] Session closed")


# ─── MCP 工具清单（架构 5.6-C：描述写使用边界 + readOnlyHint）──────────────────

def build_tools() -> List[Tool]:
    """构建 MCP 工具列表（纯函数，便于单测）。

    描述是 agent 的第一识别入口，写明触发条件与使用边界；
    查询/回复类工具声明 ToolAnnotations(readOnlyHint=True)，
    使只读/plan 模式客户端免确认可调（否则只读回合连回复都做不了）。
    """
    readonly = ToolAnnotations(readOnlyHint=True)
    return [
        Tool(
            name="register_agent",
            description="向 AgentBus hub 注册本 Agent 的信息（名称/描述/能力）。"
                        "必须先注册才能发送消息与被其他 Agent 按能力发现；仅写注册信息，不发送消息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Agent 名称"},
                    "description": {"type": "string", "description": "Agent 描述"},
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Agent 能力列表",
                    },
                    "metadata": {"type": "object", "description": "额外元信息"},
                },
                "required": ["name", "description", "capabilities"],
            },
        ),
        Tool(
            name="update_agent",
            description="更新本 Agent 在 AgentBus hub 上已注册的能力与元信息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "新的能力列表",
                    },
                    "metadata": {"type": "object", "description": "更新的元信息"},
                },
            },
        ),
        Tool(
            name="send_message",
            description="通过 AgentBus 总线发送消息给指定 Agent。"
                        "仅在用户明确要求跨 Agent 协作、或回复 [AgentBus] 入站消息时使用；"
                        "回复入站消息需携带 reply_to（取信封中的消息 id）。"
                        "需先调用 register_agent 注册自身。",
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "消息内容"},
                    "to": {"type": ["string", "array"], "description": "目标 Agent 的 client_id"},
                    "type": {"type": "string", "default": "text"},
                },
                "required": ["text", "to"],
            },
            annotations=readonly,
        ),
        Tool(
            name="ack_message",
            description="对消息 ID 回执确认（确认收到入站消息）；仅用于回应 [AgentBus] 入站信封，不发送任何内容。",
            inputSchema={
                "type": "object",
                "properties": {"id": {"type": "string", "description": "消息 ID"}},
                "required": ["id"],
            },
            annotations=readonly,
        ),
        Tool(
            name="list_agents",
            description="查询所有在线 Agent 及其能力列表（只读查询，不修改任何状态）。",
            inputSchema={"type": "object", "properties": {}},
            annotations=readonly,
        ),
        Tool(
            name="get_agent_info",
            description="查询指定 Agent 的注册详细信息（只读查询）。",
            inputSchema={
                "type": "object",
                "properties": {"client_id": {"type": "string"}},
                "required": ["client_id"],
            },
            annotations=readonly,
        ),
        Tool(
            name="find_agents_by_capability",
            description="按能力查找声明了该能力的 Agent（只读查询）。",
            inputSchema={
                "type": "object",
                "properties": {"capability": {"type": "string", "description": "要查找的能力"}},
                "required": ["capability"],
            },
            annotations=readonly,
        ),
        Tool(
            name="get_status",
            description="查询本 Agent 当前总线状态（注册/连接信息，只读查询）。",
            inputSchema={"type": "object", "properties": {}},
            annotations=readonly,
        ),
    ]


# ─── MCP Server 创建 ──────────────────────────────────────────────────────────

def create_mcp_server(client_id: str, ns: Optional[str] = None) -> Server:
    key = session_key(client_id, ns)
    server = Server(f"agent-{key}")
    
    loop = asyncio.get_running_loop()
    if key not in _sessions:
        session = AgentSession(client_id, loop, ns)
        session.start()
        _sessions[key] = session
    else:
        session = _sessions[key]
    
    session.mcp_server = server
    _servers[key] = server
    
    logger.info(f"[{key}] MCP Server created")
    
    @server.list_tools()
    async def list_tools() -> List[Tool]:
        # 首次请求时捕获会话，供 MQTT 线程跨上下文推送使用
        if session.mcp_session is None:
            session.mcp_session = server.request_context.session
        return build_tools()
    
    async def handle_tool(name: str, arguments: dict) -> List[TextContent]:
        
        if name == "register_agent":
            result = session.register(
                name=arguments["name"],
                description=arguments["description"],
                capabilities=arguments["capabilities"],
                metadata=arguments.get("metadata"),
            )
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
        
        elif name == "update_agent":
            if not session.is_registered():
                return [TextContent(type="text", text=json.dumps({"error": "请先调用 register_agent 注册"}, indent=2))]
            session.info.update(
                capabilities=arguments.get("capabilities"),
                metadata=arguments.get("metadata"),
            )
            return [TextContent(type="text", text=json.dumps({"status": "updated", "client_id": client_id}, indent=2))]
        
        elif name == "send_message":
            if not session.is_registered():
                return [TextContent(type="text", text=json.dumps({
                    "error": "请先调用 register_agent 注册自己的信息",
                    "hint": "register_agent(name, description, capabilities)",
                }, ensure_ascii=False, indent=2))]
            
            text = arguments["text"]
            to = arguments["to"]
            msg_type = arguments.get("type", "text")
            
            try:
                check_text_size(text)
                targets = split_targets(to)
            except ValueError as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e)}, ensure_ascii=False, indent=2))]
            
            # 目标键解析（无前缀继承发件人 ns）；不在会话表 ≠ 离线，未知目标尽力发布（架构 5.5）
            target_keys = []
            for t in targets:
                t_ns, cid, _tool = resolve_target(t)
                target_keys.append(session_key(cid, t_ns if t_ns is not None else session.ns))
            delivered, unknown = plan_send_targets(target_keys, set(_sessions.keys()))
            
            # 就绪门控（TASK-13 冒烟缺陷）：等自身收件 topic 订阅完成再发，防早到回复丢失
            ready = await asyncio.to_thread(session.wait_ready, 5.0)
            if not ready:
                return [TextContent(type="text", text=json.dumps({
                    "error": "MQTT 连接尚未就绪（收件订阅未完成），请稍后重试",
                }, ensure_ascii=False, indent=2))]
            
            result = session.send_message(text, delivered, msg_type)
            if unknown:
                result["unconfirmed"] = unknown
                result["note"] = "以下目标未保持 SSE 会话（可能是纯 MQTT 直连），已尽力发布，在线状态未知"
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
        
        elif name == "ack_message":
            msg_id = arguments["id"]
            stored = _messages.get(msg_id)
            if stored is None:
                return [TextContent(type="text", text=json.dumps({"error": "Unknown message id"}, indent=2))]
            if not can_ack(stored, session.key):
                return [TextContent(type="text", text=json.dumps({"error": "无权确认该消息（仅发送方/接收方可 ack）"}, ensure_ascii=False, indent=2))]
            stored["acknowledged"] = True
            stored["acknowledged_at"] = datetime.now(timezone.utc).isoformat()
            logger.info(f"[{session.key}] Acknowledged: {msg_id}")
            return [TextContent(type="text", text=json.dumps({"status": "acknowledged", "id": msg_id}, indent=2))]
        
        elif name == "list_agents":
            agents = []
            for cid, sess in _sessions.items():
                info = sess.info.to_dict()
                info["mqtt_connected"] = sess.connected
                agents.append(info)
            return [TextContent(type="text", text=json.dumps(agents, ensure_ascii=False, indent=2))]
        
        elif name == "get_agent_info":
            target = resolve_agent_key(arguments["client_id"], session.ns)
            if target in _agent_info:
                info = _agent_info[target].to_dict()
                if target in _sessions:
                    info["mqtt_connected"] = _sessions[target].connected
                return [TextContent(type="text", text=json.dumps(info, ensure_ascii=False, indent=2))]
            return [TextContent(type="text", text=json.dumps({"error": "Agent not found"}, indent=2))]
        
        elif name == "find_agents_by_capability":
            capability = arguments["capability"]
            found = []
            for cid, info in _agent_info.items():
                if capability in info.capabilities and info.registered:
                    found.append({
                        "client_id": cid,
                        "name": info.name,
                        "capabilities": info.capabilities,
                    })
            return [TextContent(type="text", text=json.dumps(found, ensure_ascii=False, indent=2))]
        
        elif name == "get_status":
            return [TextContent(type="text", text=json.dumps({
                "client_id": client_id,
                "registered": session.is_registered(),
                "mqtt_connected": session.connected,
                "sub_topic": session.sub_topic,
                "mqtt_broker": f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}",
                **session.info.to_dict(),
            }, indent=2))]
        
        return [TextContent(type="text", text=f"Unknown tool: {name}")]
    
    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> List[TextContent]:
        if session.mcp_session is None:
            session.mcp_session = server.request_context.session
        try:
            return await handle_tool(name, arguments or {})
        except Exception as e:
            logger.error(f"[{client_id}] Tool {name} failed: {e}")
            return [TextContent(type="text", text=f"Tool error: {e}")]
    
    return server


# ─── HTTP 路由 ────────────────────────────────────────────────────────────────

# SSE 传输必须是单例：/sse 与 /messages/ 共享同一实例，才能按 session_id 对上会话
sse_transport = SseServerTransport("/messages/")


async def health(request: Request):
    ns_summary: Dict[str, int] = {}
    for key in _sessions.keys():
        ns_name = key.split("/", 1)[0] if "/" in key else "flat"
        ns_summary[ns_name] = ns_summary.get(ns_name, 0) + 1
    return JSONResponse({
        "status": "ok",
        "service": "agentbus-hub",
        "mqtt_broker": f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}",
        "online_agents": list(_sessions.keys()),
        "registered_agents": [cid for cid, info in _agent_info.items() if info.registered],
        "total_messages": len(_messages),
        "namespaces": ns_summary,
        # TASK-19：各 daemon 最新指标（注入成功率/丢弃/去重/排队/在线会话数）
        "daemon_metrics": _metrics_store.snapshot(),
    })


# ─── Web 控制台后端 API（TASK-20：覆盖前端三页 ns/权限/指标） ─────────────────────

def _console_snapshot_sources():
    """控制台三个清单接口的公共数据源（会话表/注册表/指标库快照）"""
    return list(_sessions.keys()), list(_agent_info.keys()), list(_metrics_store.snapshot().keys())


async def console_namespaces(request: Request):
    """ns 页：命名空间清单（在线/注册/daemon 计数 + 显式声明标记）"""
    session_keys, agent_keys, metric_keys = _console_snapshot_sources()
    return JSONResponse({"namespaces": collect_namespaces(
        session_keys, agent_keys, metric_keys, _ns_registry.list())})


async def console_declare_namespace(request: Request):
    """ns 页：声明创建命名空间（ns 隔离由 topic 路径天然实现，此处仅登记）"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体须为 JSON 对象"}, status_code=400)
    entry = _ns_registry.declare((body or {}).get("name", ""))
    if entry is None:
        return JSONResponse({"error": "ns 名非空且不得含 /"}, status_code=400)
    return JSONResponse({"status": "declared", "namespace": entry})


async def console_identities(request: Request):
    """ns 页：<ns>/<client_id> 身份清单与检索（?ns= 过滤，?q= 子串检索）"""
    session_keys, agent_keys, metric_keys = _console_snapshot_sources()
    ns = normalize_ns(request.query_params.get("ns"))
    q = (request.query_params.get("q") or "").strip() or None
    return JSONResponse({"identities": collect_identities(
        session_keys, agent_keys, metric_keys, ns=ns, q=q)})


async def console_permissions_list(request: Request):
    """权限页：全部权限档案"""
    return JSONResponse({"profiles": _permission_store.list()})


async def console_permission_get(request: Request):
    """权限页：单个身份档案（未存档 404）"""
    entry = _permission_store.get(request.path_params["identity"])
    if entry is None:
        return JSONResponse({"error": "该身份暂无权限档案"}, status_code=404)
    return JSONResponse({"identity": request.path_params["identity"], "profile": entry})


async def console_permission_put(request: Request):
    """权限页：保存档案并下发 control 通知（校验对齐 daemon config 契约）"""
    identity = request.path_params["identity"]
    try:
        body = await request.json()
        profile = validate_permission_profile(body)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "请求体须为 JSON 对象"}, status_code=400)
    entry = _permission_store.set(identity, profile)
    distributed = distribute_permission_update(identity, profile)
    logger.info(f"[console] 权限档案更新 {identity}（下发 {'成功' if distributed else '未送达，仅存档'}）")
    return JSONResponse({"identity": identity, "profile": entry, "distributed": distributed})


async def console_metrics(request: Request):
    """指标页：各 daemon 最新指标 + hub 概览（在线/注册/消息数/ns 分布）"""
    ns_summary: Dict[str, int] = {}
    for key in _sessions.keys():
        ns_summary[_ns_of(key)] = ns_summary.get(_ns_of(key), 0) + 1
    return JSONResponse({
        "daemons": _metrics_store.snapshot(),
        "overview": {
            "online_agents": list(_sessions.keys()),
            "registered_agents": [k for k, info in _agent_info.items() if info.registered],
            "total_messages": len(_messages),
            "namespaces": ns_summary,
        },
    })


async def console_metrics_summary(request: Request):
    """指标页：全部 daemon 指标汇总（吞吐/丢弃/去重/排队总量）"""
    return JSONResponse(build_metric_summary(_metrics_store.snapshot()))


# TASK-21：控制台前端单页（web/index.html 直出，无构建步骤；三页：ns/权限/指标）
CONSOLE_HTML = Path(__file__).resolve().parent / "web" / "index.html"


async def console_page(request: Request):
    if not CONSOLE_HTML.exists():
        return JSONResponse({"error": "控制台页面缺失（web/index.html）"}, status_code=500)
    return Response(CONSOLE_HTML.read_text(encoding="utf-8"), media_type="text/html; charset=utf-8")


async def sse_endpoint(request: Request):
    client_id = request.query_params.get("client_id") or request.headers.get("x-client-id", "")
    ns = normalize_ns(request.query_params.get("ns"))
    
    if not client_id:
        return JSONResponse({"error": "client_id required"}, status_code=400)
    
    key = session_key(client_id, ns)
    logger.info(f"[{key}] SSE connecting...")
    
    mcp_server = create_mcp_server(client_id, ns)
    
    try:
        async with sse_transport.connect_sse(request.scope, request.receive, request._send) as streams:
            logger.info(f"[{key}] SSE connected")
            await mcp_server.run(streams[0], streams[1], mcp_server.create_initialization_options())
    except Exception as e:
        logger.error(f"[{key}] SSE error: {e}")
    finally:
        if key in _sessions:
            _sessions[key].close()  # close 内部已从路由表移除
        _servers.pop(key, None)
        # 断线清理（11.8 缺陷 2）：会话消失后同步移除元信息，防止 _agent_info 泄漏
        _agent_info.pop(key, None)
        logger.info(f"[{key}] SSE disconnected")
    
    # SSE 流已在 connect_sse 内发送完毕，返回空响应避免 starlette 报 TypeError
    return Response(status_code=204)


# ─── 应用 ─────────────────────────────────────────────────────────────────────

# handle_post_message 本身是 ASGI 应用（自己发送 202 响应），必须用 Mount 挂载，
# 不能用 Route 包一层，否则 starlette 会尝试调用返回的 None 导致 TypeError
@asynccontextmanager
async def hub_lifespan(app):
    # TASK-24：随应用生命周期启停 hub 唯一共享 MQTT 连接（含 TASK-19 metric 订阅）
    start_shared_client()
    yield
    stop_shared_client()


_teams_store = TeamStore()


async def console_teams_list(request: Request):
    """团队页：团队清单（TASK-26）"""
    return JSONResponse({"teams": list(_teams_store.list().values())})


async def console_team_create(request: Request):
    """团队页：创建团队（团队名即 ns，broker 账号 team-<名>，ACL 由同步脚本落地）"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体须为 JSON 对象"}, status_code=400)
    body = body or {}
    name = (body.get("name") or "").strip()
    if not _TEAM_NAME_RE.match(name):
        return JSONResponse(
            {"error": "团队名须为小写字母/数字/中划线（同 ns 命名规则）"}, status_code=400)
    members = body.get("members", [])
    if not isinstance(members, list):
        return JSONResponse({"error": "members 须为字符串数组"}, status_code=400)
    entry = _teams_store.create(name, members=members)
    if entry is None:
        return JSONResponse({"error": f"团队已存在: {name}"}, status_code=409)
    return JSONResponse({"status": "created", "team": entry})


async def console_team_delete(request: Request):
    """团队页：删除团队（broker 账号/ACL 需再跑同步脚本才会失效）"""
    name = request.path_params["name"]
    if _teams_store.delete(name):
        return JSONResponse({"status": "deleted", "name": name})
    return JSONResponse({"error": f"团队不存在: {name}"}, status_code=404)


app = Starlette(
    routes=[
        Route("/health", health),
        Route("/sse", sse_endpoint),
        Mount("/messages/", app=sse_transport.handle_post_message),
        # TASK-20：Web 控制台后端 API（前端三页：ns/权限/指标）
        Route("/api/console/namespaces", console_namespaces, methods=["GET"]),
        Route("/api/console/namespaces", console_declare_namespace, methods=["POST"]),
        Route("/api/console/identities", console_identities, methods=["GET"]),
        Route("/api/console/permissions", console_permissions_list, methods=["GET"]),
        Route("/api/console/permissions/{identity:path}", console_permission_get, methods=["GET"]),
        Route("/api/console/permissions/{identity:path}", console_permission_put, methods=["PUT"]),
        Route("/api/console/metrics", console_metrics, methods=["GET"]),
        Route("/api/console/metrics/summary", console_metrics_summary, methods=["GET"]),
        # TASK-21：控制台前端页面
        Route("/console", console_page, methods=["GET"]),
        # TASK-26：团队管理（一团队一账号 ACL）
        Route("/api/console/teams", console_teams_list, methods=["GET"]),
        Route("/api/console/teams", console_team_create, methods=["POST"]),
        Route("/api/console/teams/{name}", console_team_delete, methods=["DELETE"]),
    ],
    lifespan=hub_lifespan,
)


# ─── TASK-25：SSE/控制台接入鉴权（安全基线） ───────────────────────────────
# 契约：MCP_API_TOKEN 非空时启用——/sse、/messages/*、/console、/api/console/*
# 须携带 ?token= 或 Authorization: Bearer；/health 开放（监控探针）。
# 未设 token 时保持全开放（内网/开发兼容）。

def check_auth_token(enabled: bool, provided: Optional[str]) -> bool:
    """纯函数鉴权判定：未启用放行；启用后仅正确 token 放行。"""
    if not enabled:
        return True
    expected = os.getenv("MCP_API_TOKEN") or ""
    return bool(provided) and provided == expected


def extract_token(scope: dict) -> Optional[str]:
    """从 ASGI scope 提取 token：query ?token= 优先，其次 Authorization: Bearer。"""
    from urllib.parse import parse_qs
    qs = (scope.get("query_string") or b"").decode("latin-1")
    tokens = parse_qs(qs).get("token")
    if tokens:
        return tokens[0]
    for key, value in scope.get("headers") or []:
        if key.lower() == b"authorization":
            text = value.decode("latin-1")
            if text.lower().startswith("bearer "):
                return text[7:].strip() or None
    return None


class TokenAuthMiddleware:
    """纯 ASGI 中间件（不用 BaseHTTPMiddleware，避免对 SSE 流的缓冲问题）。"""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        expected = os.getenv("MCP_API_TOKEN") or ""
        if scope["type"] != "http" or path.startswith("/health") or not expected:
            await self.inner(scope, receive, send)
            return
        if check_auth_token(True, extract_token(scope)):
            await self.inner(scope, receive, send)
            return
        body = json.dumps({
            "error": "unauthorized",
            "detail": "token required (?token= or Authorization: Bearer)",
        }).encode("utf-8")
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})


app_with_auth = TokenAuthMiddleware(app)


async def run_stdio(client_id: str):
    from mcp.server.stdio import stdio_server
    server = create_mcp_server(client_id)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "stdio":
        asyncio.run(run_stdio(sys.argv[2] if len(sys.argv) > 2 else "default"))
    else:
        import uvicorn
        logger.info(f"Starting MCP MQTT Bridge on {MCP_HOST}:{MCP_PORT}")
        logger.info(f"MQTT Broker: {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}")
        uvicorn.run(app_with_auth, host=MCP_HOST, port=MCP_PORT)
