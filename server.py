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
    /agentbus/ai/channel/{client_id}/message

MCP 工具：
├── update_agent(name?, description?, capabilities)     自述档案（直写 hub DB）
├── send_message(text, to, type)                        发送消息（仅向在线目标）
├── get_agent_info(client_id)                         查询 Agent 信息
├── find_agents_by_capability(capability)             按能力查找
├── list_agents()                                     列出所有 Agent
└── get_status()                                      获取状态
"""

import asyncio
import base64
import json
import logging
import os
import re
import threading
import uuid
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Dict, List, Union, Tuple
from dataclasses import dataclass, field

import paho.mqtt.client as mqtt
from mcp.server import Server
from mcp.server.session import ServerSession
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent, ToolAnnotations
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from pathlib import Path

# 四期：账号体系（SQLite 存储 / session 鉴权 / dynsec 客户端 / 生命周期编排）
from hub import accounts as hub_accounts
from hub import auth as hub_auth
from hub import dynsec as hub_dynsec
from hub import store as hub_store

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
# 对外展示的 broker 地址（默认按浏览器请求 host 派生；broker 与 hub 分机部署时用完整 host:port 覆盖）
PUBLIC_BROKER = os.getenv("AGENTBUS_PUBLIC_BROKER", "")
# broker 对外暴露端口（容器内 MQTT_BROKER_PORT 是内网端口；docker-compose 固定映射 18830）
PUBLIC_BROKER_PORT = os.getenv("AGENTBUS_BROKER_PUBLIC_PORT", "")

# ─── Topic ────────────────────────────────────────────────────────────────────
TOPIC_MESSAGE = "/agentbus/ai/channel/{client_id}/message"

# TASK-33：daemon 在线态通道（LWT 遗嘱 + retained online/offline）
TOPIC_STATUS_PREFIX = "/agentbus/ai/status/"
TOPIC_STATUS_WILDCARD = "/agentbus/ai/status/#"

# 四期：共享连接通配订阅（flat 兼容已删除，仅 ns 形态）
TOPIC_MESSAGE_PREFIX = "/agentbus/ai/channel/"
TOPIC_MESSAGE_WILDCARD_NS = "/agentbus/ai/channel/+/+/message"

# 消息体上限（架构 11.8 缺陷 5）：防止异常大包占满 broker 与内存
MAX_TEXT_BYTES = 64 * 1024


# ─── 纯逻辑层（TASK-01 提取，可单测；行为规则见架构 3.1 兼容规则） ────────────────


@dataclass
class PendingReply:
    """等待回复的请求条目"""
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reply: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)


# 全局等待回复存储：{msg_id: PendingReply}
_pending_replies: Dict[str, PendingReply] = {}

# 全局事件循环引用（供 on_message 线程安全调用）
_main_loop: Optional[asyncio.AbstractEventLoop] = None


# ─── 通信图谱存储：{(from_agent, to_agent): [timestamps]} ───
_comm_graph: Dict[Tuple[str, str], List[datetime]] = {}


def record_communication(from_agent: str, to_agents: List[str]) -> None:
    """记录一次通信（供 send_message 调用）"""
    now = datetime.now(timezone.utc)
    for to in to_agents:
        key = (from_agent, to)
        if key not in _comm_graph:
            _comm_graph[key] = []
        _comm_graph[key].append(now)
        # 限制存储大小，保留最近 1000 条
        if len(_comm_graph[key]) > 1000:
            _comm_graph[key] = _comm_graph[key][-500:]


def get_communication_graph(window_hours: int = 1, ns: Optional[str] = None) -> dict:
    """获取通信图谱（最近 N 小时）。

    节点来源：_agent_info 中所有已注册 Agent（注册即显示）；
    边来源：_comm_graph 中有通信记录才出现连线。
    ns 过滤：非 None 时只返回该 ns 下的节点和边。
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    now = datetime.now(timezone.utc)
    presence = _presence_store.snapshot()

    # 节点：从 _agent_info 取所有已注册 Agent（注册即显示）
    node_keys = set()
    for key in _agent_info:
        if ns is None or key.startswith(f"{ns}/"):
            node_keys.add(key)
    # 也包含有通信但不在 _agent_info 的（历史数据兼容）
    for (from_a, to_a) in _comm_graph:
        if ns is None or from_a.startswith(f"{ns}/"):
            node_keys.add(from_a)
        if ns is None or to_a.startswith(f"{ns}/"):
            node_keys.add(to_a)

    nodes = []
    for key in sorted(node_keys):
        info = _agent_info.get(key)
        name = info.name if info else key.split("/")[-1]
        nodes.append({
            "id": key,
            "name": name or key.split("/")[-1],
            "online": agent_online(key, presence, now),
        })

    # 边：从 _comm_graph 提取有通信的
    edges = []
    seen_edges = set()
    for (from_a, to_a), timestamps in _comm_graph.items():
        recent = [ts for ts in timestamps if ts > cutoff]
        if not recent:
            continue
        # 两端都须在节点集合中
        if from_a not in node_keys or to_a not in node_keys:
            continue
        forward_count = len([ts for ts in _comm_graph.get((from_a, to_a), []) if ts > cutoff])
        reverse_count = len([ts for ts in _comm_graph.get((to_a, from_a), []) if ts > cutoff])
        edge_key = tuple(sorted([from_a, to_a]))
        if edge_key not in seen_edges:
            seen_edges.add(edge_key)
            edges.append({
                "agents": [from_a, to_a],
                "counts": {
                    f"{from_a}→{to_a}": forward_count,
                    f"{to_a}→{from_a}": reverse_count,
                },
                "last_ts": max(recent).isoformat()
            })

    return {"nodes": nodes, "edges": edges}


def build_sub_topic(client_id: str, ns: Optional[str] = None) -> str:
    """构造订阅/推送 topic。ns=None → 旧 flat topic（兼容存量）；显式 ns → ns topic"""
    if ns is None:
        return TOPIC_MESSAGE.format(client_id=client_id)
    return f"/agentbus/ai/channel/{ns}/{client_id}/message"


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



def parse_status_topic(topic: str) -> Optional[str]:
    """/agentbus/ai/status/<ns>/<cid> → <ns>/<cid>；段数不符返回 None"""
    if not topic.startswith(TOPIC_STATUS_PREFIX):
        return None
    parts = topic[len(TOPIC_STATUS_PREFIX):].split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return f"{parts[0]}/{parts[1]}"


def parse_message_topic(topic: str) -> Optional[tuple]:
    """TASK-24：message topic → (ns, client_id)。共享连接按 topic 路由的第一步：
    ns /agentbus/ai/channel/<ns>/<cid>/message → (ns, cid)；
    四期：flat 兼容已删除，其余（含 metric）返回 None"""
    if (not topic or not topic.startswith(TOPIC_MESSAGE_PREFIX)
            or not topic.endswith("/message")):
        return None
    parts = topic[len(TOPIC_MESSAGE_PREFIX):-len("/message")].split("/")
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


class PresenceStore:
    """LWT 在线态：daemon 状态事件（online/offline）以最新一条为准"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}

    def update(self, identity: str, state: str, ts: Optional[str], reason: str = "") -> None:
        with self._lock:
            self._data[identity] = {"state": state, "ts": ts, "reason": reason}

    def snapshot(self) -> Dict[str, dict]:
        with self._lock:
            return {k: dict(v) for k, v in self._data.items()}

    def remove(self, identity: str) -> None:
        with self._lock:
            self._data.pop(identity, None)


# ─── TASK-32：投递前在线检查（纯函数，窗口与 daemon 30s 上报周期匹配） ─────


def _offline_targets(targets: List[str], snapshot: Dict[str, dict], now: datetime,
                     window_s: int = 90) -> List[str]:
    """目标在线判定：metric 条目 last_seen 在窗口内才算在线；无条目/时间戳非法/过期
    均视为离线。返回离线目标列表（保序）；空目标 → 空列表。"""
    offline = []
    for t in targets:
        entry = snapshot.get(t)
        last_seen = entry.get("last_seen") if isinstance(entry, dict) else None
        try:
            ts = datetime.fromisoformat(str(last_seen).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            offline.append(t)
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if now - ts > timedelta(seconds=window_s):
            offline.append(t)
    return offline


# ─── TASK-33：presence 统一在线判定（0.2.10：presence 唯一真源 + 60s 心跳兜底） ───


def _parse_iso(ts: Any) -> Optional[datetime]:
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
    except (ValueError, TypeError):
        return None


# 心跳兜底窗口：presence=online 但超过该秒数无任何心跳 → 强制判离线（断网/遗嘱丢失防线）
PRESENCE_HEARTBEAT_WINDOW_S = 60


def agent_online(key: str, presence: Dict[str, dict],
                 now: datetime, heartbeat_s: int = PRESENCE_HEARTBEAT_WINDOW_S) -> bool:
    """统一在线判定（0.2.10 收敛）：presence 唯一真源——条目 state=online 且心跳
    （presence ts / 指标 last_seen 取新）在窗口内才算在线；无条目/offline/心跳超期
    一律离线。旧客户端 90s 指标回退已删：daemon stop 即翻离线，不再假在线。"""
    p = presence.get(key)
    if p is None or p.get("state") != "online":
        return False
    ts = _parse_iso(p.get("ts"))
    if ts is None:
        return False
    return (now - ts).total_seconds() <= heartbeat_s


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
_agent_info: Dict[str, AgentInfo] = {}


def _split_key(key: str) -> tuple:
    """拆分 ns/client_id 键"""
    if "/" in key:
        ns, cid = key.split("/", 1)
        return ns, cid
    return "", key


def _save_agent_db(key: str) -> None:
    """将内存中的 AgentInfo 同步持久化到 SQLite"""
    info = _agent_info.get(key)
    if info is None:
        return
    ns, cid = _split_key(key)
    if not ns:
        return  # 无 ns 的旧格式不持久化
    try:
        hub_store.upsert_agent(
            DB_CONN, ns, cid,
            name=info.name or "",
            description=info.description or "",
            capabilities=info.capabilities,
            registered_at=info.registered_at.isoformat() if info.registered_at else None,
        )
    except Exception as e:
        logger.error(f"[agent-persist] save failed for {key}: {e}")


def _delete_agent_db(key: str) -> None:
    """从 SQLite 删除 Agent 档案"""
    ns, cid = _split_key(key)
    if not ns:
        return
    try:
        hub_store.delete_agent(DB_CONN, ns, cid)
    except Exception as e:
        logger.error(f"[agent-persist] delete failed for {key}: {e}")


def _load_agents_from_db() -> None:
    """启动时从 SQLite 加载所有 Agent 档案到内存"""
    try:
        rows = hub_store.list_agents(DB_CONN)
        for row in rows:
            key = f"{row['ns']}/{row['client_id']}"
            info = AgentInfo(row["client_id"])
            info.name = row["name"] or None
            info.description = row["description"] or None
            info.capabilities = row.get("capabilities") or []
            info.registered = True
            if row.get("registered_at"):
                try:
                    info.registered_at = datetime.fromisoformat(row["registered_at"])
                except Exception:
                    pass
            _agent_info[key] = info
        if rows:
            logger.info(f"[agent-persist] loaded {len(rows)} agents from DB")
    except Exception as e:
        logger.error(f"[agent-persist] load failed: {e}")

# LWT 在线态（TASK-33）：status topic 事件流维护，send_message/明细页/list_agents 统一口径
_presence_store = PresenceStore()

# TASK-24：hub 唯一 MQTT 共享连接（架构 11.8 演进方案 2：线程数 N→1）
_shared_client: Optional[mqtt.Client] = None
_shared_ready = threading.Event()


def _handle_presence_message(msg) -> None:
    """TASK-33 presence 事件入库：payload.identity 优先，但必须与 topic 身份一致（防跨 ns 伪造）；
    缺失时回退 topic 推导（retained/遗嘱同路径）"""
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return
    if not isinstance(payload, dict):
        return
    topic_identity = parse_status_topic(msg.topic)
    identity = payload.get("identity")
    if not (isinstance(identity, str) and identity.strip()):
        identity = topic_identity
    if not identity:
        return
    if topic_identity and identity != topic_identity:
        logger.warning(f"presence 身份不匹配丢弃：topic={msg.topic} payload.identity={identity}")
        return
    state = payload.get("state")
    if state not in ("online", "offline"):
        return
    _presence_store.update(identity, state, payload.get("ts"), str(payload.get("reason") or ""))


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
                (TOPIC_MESSAGE_WILDCARD_NS, 2),
                (TOPIC_STATUS_WILDCARD, 1),
                (hub_dynsec.RESPONSE_TOPIC, 1),
            ])
            _shared_ready.set()
            logger.info(f"[hub-shared] subscribed to {TOPIC_MESSAGE_WILDCARD_NS}, {TOPIC_STATUS_WILDCARD}, {hub_dynsec.RESPONSE_TOPIC}")
        else:
            logger.error(f"[hub-shared] connect failed: rc={rc}")

    def on_disconnect(c, userdata, flags, rc, properties=None):
        _shared_ready.clear()
        logger.warning(f"[hub-shared] MQTT disconnected (rc={rc})")

    def on_message(c, userdata, msg):
        if msg.topic == hub_dynsec.RESPONSE_TOPIC:
            # 四期：dynsec 命令响应转给客户端执行器（串行请求-响应配对）
            if DYNSEC_CLIENT is not None:
                DYNSEC_CLIENT.on_response(msg.payload)
            return
        if msg.topic.startswith(TOPIC_STATUS_PREFIX):
            _handle_presence_message(msg)
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
        # 匹配等待中的回复
        reply_to = payload.get("reply_to")
        if reply_to and reply_to in _pending_replies:
            pending = _pending_replies[reply_to]
            pending.reply = payload
            # 线程安全地设置 Event（on_message 运行在 MQTT 线程）
            if _main_loop:
                _main_loop.call_soon_threadsafe(pending.event.set)
            logger.info(f"[hub] matched pending reply for msg_id={reply_to}")
            return  # 已被等待方消费，不再推送

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

        # 已有档案（hub 重启从 DB 恢复 / 上一会话遗留）必须复用而非覆盖：
        # 否则每次 SSE 重连都会把名称/描述/能力/注册态抹成空白，
        # list_agents/get_agent_info 返回空壳，/health 的 registered_agents 丢失
        existing = _agent_info.get(self.key)
        self.info = existing if existing is not None else AgentInfo(self.key)
        _agent_info[self.key] = self.info

    @property
    def connected(self) -> bool:
        """仅内部用（hub 共享链路健康探测）；对外 mqtt_connected 字段一律走 agent_online"""
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
        _save_agent_db(self.key)
        logger.info(f"[{self.client_id}] Agent registered: {name}")
        return {
            "status": "registered",
            "client_id": self.client_id,
            "name": name,
            "capabilities": capabilities,
        }
    
    def send_message(self, text: str, to: Union[str, List[str]], msg_type: str = "text",
                     session_id: Optional[str] = None,
                     expect_reply: bool = False,
                     reply_to: Optional[str] = None) -> dict:
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
        # Plan 3 问题 2：发送方本地会话 ID（可选），回复时回显，发起方据此注回原会话
        if isinstance(session_id, str) and session_id.strip():
            payload["session"] = session_id.strip()
        # 阻塞等待模式：告知接收方需要回复
        if expect_reply:
            payload["expect_reply"] = True
        if isinstance(reply_to, str) and reply_to.strip():
            payload["reply_to"] = reply_to.strip()
        
        sent_to = split_targets(to)
        pub_topics = build_pub_topics(to, self.ns)
        message_json = json.dumps(payload, ensure_ascii=False)
        if _shared_client is None:
            raise RuntimeError("共享 MQTT 连接未启动（hub lifespan 未生效），无法发送")
        for pub_topic in pub_topics:
            _shared_client.publish(pub_topic, message_json, qos=2)
            logger.info(f"[{self.client_id}] Published to {pub_topic}")
        
        self.info.last_active = datetime.now(timezone.utc)
        
        # 记录通信图谱
        record_communication(self.key, sent_to)
        
        return {
            "status": "sent",
            "id": msg_id,
            "to": sent_to,
        }
    
    def close(self):
        # TASK-24：会话下线从路由表移除；共享连接由 lifespan 统一停止
        _sessions.pop(self.key, None)
        logger.info(f"[{self.client_id}] Session closed")


# ─── 阻塞等待回复 ───────────────────────────────────────────────────────────

async def send_message_with_wait(
    session: AgentSession,
    text: str,
    to: List[str],
    msg_id: str,
    timeout: float = 300.0,
    session_id: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> dict:
    """发送消息并阻塞等待回复
    
    Args:
        session: 发送方会话
        text: 消息正文
        to: 目标列表
        msg_id: 消息 ID
        timeout: 等待超时（秒），0 表示无限
        session_id: 会话 ID
        reply_to: 回复的原消息 ID
        
    Returns:
        {"status": "replied", "reply": ...} 或 {"status": "timeout", ...}
    """
    # 注册等待
    pending = PendingReply()
    _pending_replies[msg_id] = pending
    
    try:
        # 发送消息（携带 expect_reply=true）
        session.send_message(text, to, "text", session_id, expect_reply=True, reply_to=reply_to)
        
        # 无限等待或超时等待
        if timeout <= 0:
            await pending.event.wait()
        else:
            await asyncio.wait_for(pending.event.wait(), timeout=timeout)
        
        if pending.error:
            return {"status": "error", "error": pending.error, "msg_id": msg_id}
        
        return {
            "status": "replied",
            "msg_id": msg_id,
            "reply": pending.reply,
        }
    except asyncio.TimeoutError:
        return {"status": "timeout", "msg_id": msg_id, "hint": f"等待 {timeout}s 超时"}
    except Exception as e:
        return {"status": "error", "error": str(e), "msg_id": msg_id}
    finally:
        _pending_replies.pop(msg_id, None)


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
            name="update_agent",
            description="更新本 Agent 在 AgentBus hub 上的档案（自述用途：名称/描述/能力直接写入 hub 档案库，重启不丢）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Agent 名称（≤50 字符）",
                    },
                    "description": {
                        "type": "string",
                        "description": "Agent 描述（职责/用途一句话）",
                    },
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "新的能力列表",
                    },
                    "metadata": {"type": "object", "description": "更新的元信息（仅本次会话内存）"},
                },
            },
        ),
        Tool(
            name="send_message",
            description="通过 AgentBus 总线发送消息给指定 Agent（仅向在线 Agent 投递，目标离线时整体拒发）。"
                        "wait_reply=True 时会阻塞等待回复（默认超时 300 秒）。"
                        "仅在用户明确要求跨 Agent 协作、或回复 [AgentBus] 入站消息时使用；"
                        "回复入站消息需携带 reply_to（取信封中的消息 id）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "消息内容（不可为空）"},
                    "to": {"type": ["string", "array"], "description": "目标 Agent 的 client_id"},
                    "type": {"type": "string", "default": "text"},
                    "wait_reply": {"type": "boolean", "default": False, "description": "是否阻塞等待回复"},
                    "timeout": {"type": "number", "default": 300, "description": "等待超时（秒），0=无限等待"},
                    "reply_to": {"type": "string", "description": "回复的原消息 ID（从信封头 id 字段获取）"},
                    "session_id": {
                        "type": "string",
                        "description": "发送方本地会话 ID（可选，阻塞模式下无需传递）",
                    },
                },
                "required": ["text", "to"],
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
            description="查询本 Agent 当前总线状态（档案/连接信息，只读查询）。",
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
        # TASK-32：去门控（TASK-31 双门控已删除）——档案由 hub 中心化，工具全放行
        if name == "update_agent":
            # TASK-32：自述直写 hub 档案库（name/description/capabilities），重启不丢
            new_name = arguments.get("name")
            new_desc = arguments.get("description")
            new_caps = arguments.get("capabilities")
            if isinstance(new_name, str) and len(new_name.strip()) > AGENT_NAME_MAX:
                return [TextContent(type="text", text=json.dumps(
                    {"error": f"name 长度须 ≤ {AGENT_NAME_MAX} 字符"}, ensure_ascii=False, indent=2))]
            session.info.update(
                capabilities=new_caps,
                metadata=arguments.get("metadata"),
            )
            if isinstance(new_name, str) and new_name.strip():
                session.info.name = new_name.strip()
            if isinstance(new_desc, str):
                session.info.description = new_desc.strip()
            _save_agent_db(session.key)
            return [TextContent(type="text", text=json.dumps({"status": "updated", "client_id": client_id}, indent=2))]
        
        elif name == "send_message":
            text = arguments["text"]
            to = arguments["to"]
            msg_type = arguments.get("type", "text")
            wait_reply = arguments.get("wait_reply", False)
            timeout = arguments.get("timeout", 300)
            reply_to = arguments.get("reply_to")
            session_id = arguments.get("session_id")

            # Plan 3 问题 0：空/纯空白正文拒发（此前只校验上限，空串照发导致对端收到空信封）
            if not isinstance(text, str) or not text.strip():
                return [TextContent(type="text", text=json.dumps({
                    "error": "消息正文不能为空，请填写正文后再发送",
                    "hint": "请把要发送的内容写入 text 参数，而不是写进本地对话回复",
                }, ensure_ascii=False, indent=2))]

            try:
                check_text_size(text)
                targets = split_targets(to)
            except ValueError as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e)}, ensure_ascii=False, indent=2))]
            
            # 目标键解析（无前缀继承发件人 ns）；投递前统一在线判定（TASK-33：presence 唯一真源 + 60s 心跳兜底）
            target_keys = []
            for t in targets:
                t_ns, cid, _tool = resolve_target(t)
                target_keys.append(session_key(cid, t_ns if t_ns is not None else session.ns))
            presence = _presence_store.snapshot()
            offline = [k for k in target_keys if not agent_online(k, presence, datetime.now(timezone.utc))]
            if offline:
                err = {
                    "error": "目标离线，已拒发（仅向在线 Agent 投递）",
                    "offline_targets": offline,
                    "hint": "可稍后重试或先确认对方 daemon 在运行",
                }
                no_profile = []  # no longer tracking metrics
                if no_profile:
                    err["no_profile_hint"] = ("未找到档案，等待 daemon 上线自动建占位或运行 agentbus init："
                                              + ", ".join(no_profile))
                return [TextContent(type="text", text=json.dumps(err, ensure_ascii=False, indent=2))]

            delivered, unknown = plan_send_targets(target_keys, set(_sessions.keys()))
            
            # 就绪门控（TASK-13 冒烟缺陷）：等自身收件 topic 订阅完成再发，防早到回复丢失
            ready = await asyncio.to_thread(session.wait_ready, 5.0)
            if not ready:
                return [TextContent(type="text", text=json.dumps({
                    "error": "MQTT 连接尚未就绪（收件订阅未完成），请稍后重试",
                }, ensure_ascii=False, indent=2))]
            
            # 阻塞等待回复模式
            if wait_reply:
                msg_id = f"msg-{uuid.uuid4().hex[:12]}"
                result = await send_message_with_wait(
                    session, text, delivered, msg_id,
                    timeout=float(timeout),
                    session_id=session_id if isinstance(session_id, str) else None,
                    reply_to=reply_to,
                )
                return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
            
            # 异步发送模式（原有逻辑）
            result = session.send_message(text, delivered, msg_type,
                                          session_id if isinstance(session_id, str) else None,
                                          expect_reply=False, reply_to=reply_to)
            if unknown:
                result["unconfirmed"] = unknown
                result["note"] = "以下目标未保持 SSE 会话（可能是纯 MQTT 直连），已尽力发布，在线状态未知"
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
        
        elif name == "list_agents":
            agents = []
            presence = _presence_store.snapshot()
            for cid, sess in _sessions.items():
                info = sess.info.to_dict()
                info["mqtt_connected"] = agent_online(sess.key, presence, datetime.now(timezone.utc))
                agents.append(info)
            return [TextContent(type="text", text=json.dumps(agents, ensure_ascii=False, indent=2))]
        
        elif name == "get_agent_info":
            target = resolve_agent_key(arguments["client_id"], session.ns)
            if target in _agent_info:
                info = _agent_info[target].to_dict()
                if target in _sessions:
                    info["mqtt_connected"] = agent_online(target, _presence_store.snapshot(), datetime.now(timezone.utc))
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
            presence = _presence_store.snapshot()
            status = {
                "client_id": client_id,
                "registered": session.is_registered(),
                "mqtt_connected": agent_online(session.key, presence, datetime.now(timezone.utc)),
                "presence_state": (presence.get(session.key) or {}).get("state"),
                "sub_topic": session.sub_topic,
                "mqtt_broker": f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}",
                **session.info.to_dict(),
            }
            # Agent 档案只存内存，不读 DB
            status["online"] = agent_online(session.key, presence, datetime.now(timezone.utc))
            return [TextContent(type="text", text=json.dumps(status, ensure_ascii=False, indent=2))]
        
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
        "namespaces": ns_summary,
    })


# ─── 四期：控制台 API v4（session 鉴权 + 账号/ns 管理 + 指标 ns 过滤） ─────────────

DB_CONN = None
DYNSEC_CLIENT = None   # lifespan 注入真实客户端（共享连接发布函数）；测试可预置假客户端


def init_hub_state() -> None:
    """建 SQLite + 引导超管（幂等）+ 从 agents 表恢复档案入内存（TASK-32）。env 在调用时读取，便于测试预置。"""
    global DB_CONN
    db_path = os.getenv("AGENTBUS_DB_PATH", "data/agentbus.db")
    admin_user = os.getenv("AGENTBUS_ADMIN_USER", "")
    admin_password = os.getenv("AGENTBUS_ADMIN_PASSWORD", "")
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    DB_CONN = hub_store.open_store(db_path)
    hub_store.init_schema(DB_CONN)
    if not hub_store.list_users(DB_CONN) and admin_user:
        hub_store.create_user(DB_CONN, admin_user, hub_auth.hash_password(admin_password), "super_admin")

    # Agent 档案从 DB 恢复
    _load_agents_from_db()

    def _resolve(token):
        username = hub_store.get_session_user(DB_CONN, token)
        return hub_store.get_user(DB_CONN, username) if username else None

    hub_auth.resolve_user_by_token = _resolve


def _json_error(msg: str, code: int = 400):
    return JSONResponse({"error": msg}, status_code=code)


def _ns_visible(user, ns_id: str) -> bool:
    """可见性：超管全量；其余须为该 ns 成员"""
    return user["role"] == "super_admin" or ns_id in hub_store.list_user_namespaces(DB_CONN, user["username"])


def _can_manage_ns(user, ns_id: str) -> bool:
    """管理权：super_admin 或该 ns 的 owner；历史 ns（owner 为空）回退旧规则（ns_admin 且属该 ns）"""
    if user["role"] == "super_admin":
        return True
    ns = hub_store.get_namespace(DB_CONN, ns_id)
    if ns is None:
        return False
    if ns["owner"] is not None:
        return ns["owner"] == user["username"]
    return user["role"] == "ns_admin" and ns_id in hub_store.list_user_namespaces(DB_CONN, user["username"])


async def api_login(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    body = body or {}
    user = hub_store.get_user(DB_CONN, body.get("username", ""))
    if not hub_auth.login_ok(user, body.get("password", "")):
        return _json_error("invalid credentials", 401)
    token = hub_auth.new_token()
    now = datetime.now(timezone.utc)
    hub_store.create_session(DB_CONN, token, user["username"], now.isoformat(),
                             (now + timedelta(days=hub_auth.SESSION_TTL_DAYS)).isoformat())
    resp = JSONResponse({"username": user["username"], "role": user["role"],
                         "display_name": user["display_name"]})
    hub_auth.set_session_cookie(resp, token)
    return resp


async def api_logout(request: Request):
    token = request.cookies.get(hub_auth.COOKIE_NAME, "")
    if token:
        hub_store.delete_session(DB_CONN, token)
    resp = JSONResponse({"ok": True})
    hub_auth.clear_session_cookie(resp)
    return resp


async def api_me(request: Request):
    user = hub_auth.current_user(request)
    return JSONResponse({"username": user["username"], "role": user["role"],
                         "display_name": user["display_name"],
                         "namespaces": hub_store.list_user_namespaces(DB_CONN, user["username"])})


async def api_ns_list(request: Request):
    user = hub_auth.current_user(request)
    if user["role"] == "super_admin":
        items = hub_store.list_namespaces(DB_CONN)
    else:
        allowed = set(hub_store.list_user_namespaces(DB_CONN, user["username"]))
        items = [n for n in hub_store.list_namespaces(DB_CONN) if n["id"] in allowed]
    # 附带 owner 昵称，供控制台“拥有者”列展示
    out = []
    for n in items:
        n = dict(n)
        u = hub_store.get_user(DB_CONN, n["owner"]) if n.get("owner") else None
        n["owner_display_name"] = u["display_name"] if u else ""
        out.append(n)
    return JSONResponse(out)


async def api_ns_create(request: Request):
    user = hub_auth.current_user(request)
    if user["role"] != "super_admin":
        return _json_error("forbidden", 403)
    try:
        body = await request.json()
        # owner 记为随 ns 创建的管理员账号：ns_admin 对“自己的 ns”有编辑/成员管理权
        hub_accounts.create_namespace_with_admin(
            DB_CONN, DYNSEC_CLIENT, body["id"], body["name"], body.get("description", ""),
            body["admin_username"], body["admin_password"], owner=body["admin_username"])
    except (ValueError, KeyError) as e:
        return _json_error(str(e))
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    return JSONResponse({"ok": True})


async def api_ns_delete(request: Request):
    user = hub_auth.current_user(request)
    if user["role"] != "super_admin":
        return _json_error("forbidden", 403)
    hub_accounts.delete_namespace(DB_CONN, DYNSEC_CLIENT, request.path_params["ns"])
    return JSONResponse({"ok": True})


async def api_ns_update(request: Request):
    """编辑 ns 元数据（名称/描述）；id 不可改"""
    user = hub_auth.current_user(request)
    ns = request.path_params["ns"]
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    if hub_store.get_namespace(DB_CONN, ns) is None:
        return _json_error("ns 不存在", 404)
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    if not isinstance(body, dict) or not body or not set(body) <= {"name", "description"}:
        return _json_error("仅支持 name/description 字段（id 不可修改）")
    if "name" in body and (not isinstance(body["name"], str) or not body["name"].strip()):
        return _json_error("name 不能为空")
    hub_store.update_namespace(DB_CONN, ns, body.get("name"), body.get("description"))
    return JSONResponse({"ok": True})


async def api_accounts_list(request: Request):
    user = hub_auth.current_user(request)
    ns = request.query_params.get("ns")
    if ns:
        if not _can_manage_ns(user, ns):
            return _json_error("forbidden", 403)
        names = hub_store.list_members(DB_CONN, ns)
    else:
        if user["role"] != "super_admin":
            return _json_error("forbidden", 403)
        names = hub_store.list_users(DB_CONN)
    return JSONResponse([{"username": n,
                          "role": hub_store.get_user(DB_CONN, n)["role"],
                          "display_name": hub_store.get_user(DB_CONN, n)["display_name"]} for n in names])


async def api_accounts_search(request: Request):
    """账号检索（成员添加用）：任意已登录用户可用，用户名/昵称包含匹配，上限 10 条"""
    hub_auth.current_user(request)
    q = (request.query_params.get("q") or "").strip()
    if not q:
        return _json_error("缺少 q 参数")
    ql = q.lower()
    hits = [u for u in hub_store.list_users_detail(DB_CONN)
            if ql in u["username"].lower() or ql in u["display_name"].lower()][:10]
    return JSONResponse(hits)


async def api_account_create(request: Request):
    user = hub_auth.current_user(request)
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    body = body or {}
    ns = body.get("ns")   # 可选：建号同时入组（ns_admin 必填）
    if user["role"] == "user":
        return _json_error("forbidden", 403)
    if user["role"] == "ns_admin" and not ns:
        return _json_error("ns_admin 建号必须指定归属命名空间", 403)
    if ns and not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    display_name = str(body.get("display_name") or "").strip()
    try:
        hub_accounts.create_account(DB_CONN, DYNSEC_CLIENT, body["username"], body["password"],
                                    display_name=display_name)
        if ns:
            hub_accounts.bind(DB_CONN, DYNSEC_CLIENT, ns, body["username"])
    except (ValueError, KeyError) as e:
        return _json_error(str(e))
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})


async def api_account_delete(request: Request):
    user = hub_auth.current_user(request)
    target = request.path_params["username"]
    if user["role"] != "super_admin":
        return _json_error("forbidden", 403)
    hub_accounts.delete_account(DB_CONN, DYNSEC_CLIENT, target)
    return JSONResponse({"ok": True})


async def api_account_update(request: Request):
    """编辑账号昵称（仅 display_name）：super_admin 可改任何人，其余仅可改自己"""
    user = hub_auth.current_user(request)
    target = request.path_params["username"]
    if user["role"] != "super_admin" and target != user["username"]:
        return _json_error("forbidden", 403)
    if hub_store.get_user(DB_CONN, target) is None:
        return _json_error("账号不存在", 404)
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    if not isinstance(body, dict) or not body or not set(body) <= {"display_name"}:
        return _json_error("仅支持 display_name 字段")
    if not isinstance(body["display_name"], str):
        return _json_error("display_name 须为字符串")
    hub_store.update_user_display_name(DB_CONN, target, body["display_name"].strip())
    return JSONResponse({"ok": True})


async def api_account_password(request: Request):
    """改密：仅 super_admin 可改他人；任何角色可改自己（ns_admin 无权改成员密码）"""
    user = hub_auth.current_user(request)
    target = request.path_params["username"]
    if user["role"] != "super_admin" and target != user["username"]:
        return _json_error("forbidden", 403)
    if hub_store.get_user(DB_CONN, target) is None:
        return _json_error("账号不存在", 404)
    try:
        body = await request.json()
        hub_accounts.reset_password(DB_CONN, DYNSEC_CLIENT, target, body["password"])
    except KeyError:
        return _json_error("缺少 password 字段")
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})


async def api_member_put(request: Request):
    user = hub_auth.current_user(request)
    ns, username = request.path_params["ns"], request.path_params["username"]
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    if hub_store.get_user(DB_CONN, username) is None:
        return _json_error("账号不存在", 404)
    try:
        hub_accounts.bind(DB_CONN, DYNSEC_CLIENT, ns, username)
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})


async def api_member_delete(request: Request):
    user = hub_auth.current_user(request)
    ns, username = request.path_params["ns"], request.path_params["username"]
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    hub_accounts.unbind(DB_CONN, DYNSEC_CLIENT, ns, username)
    return JSONResponse({"ok": True})


def _public_base(request: Request) -> tuple[str, str]:
    """浏览器视角的真实访问地址：代理头（X-Forwarded-*）优先，回退直连 Host
    ——浏览器能打开控制台，说明该 host 必然可达；返回 (origin 含端口, 纯主机名)"""
    fwd_host = request.headers.get("x-forwarded-host")
    if fwd_host:
        host = fwd_host.split(",")[0].strip()
        scheme = (request.headers.get("x-forwarded-proto") or "https").split(",")[0].strip()
    else:
        host = request.headers.get("host") or request.url.netloc
        scheme = request.url.scheme
    return f"{scheme}://{host}", host.split(":")[0]


async def api_connect_command(request: Request):
    """接入命令模板：地址按浏览器请求的真实 host 派生（跨机器可达）；
    密码单向哈希不可回显，前端在用户重输密码后替换 <密码> 占位符；
    tools 可选（逗号分隔）：白名单校验防注入，未选时 init --yes 自动探测已装 CLI"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    if not ns or not _ns_visible(user, ns):
        return _json_error("forbidden", 403)
    # 可选清单与客户端 TOOL_BINARIES 对齐（agentbus/src/detect.ts）
    tools_options = ["qoder", "kilo", "opencode", "claude", "codex", "hermes"]
    tools_raw = (request.query_params.get("tools") or "").strip()
    tools = [t.strip() for t in tools_raw.split(",") if t.strip()] if tools_raw else []
    if any(t not in tools_options for t in tools):
        return _json_error(f"tools 只允许 {','.join(tools_options)}", 400)
    origin, host = _public_base(request)
    # 分机部署环境变量优先；否则 MQTT_BROKER_HOST 已是真实可达地址（如公网 IP）时沿用，
    # 仅当为容器内/本机占位值（mqtt-broker/localhost）时才按浏览器 host 派生
    # （容器内 broker 端口是内网端口，对外端口需部署方配置，见 AGENTBUS_PUBLIC_BROKER）
    if PUBLIC_BROKER:
        broker = PUBLIC_BROKER
    elif MQTT_BROKER_HOST.lower() in ("localhost", "127.0.0.1", "mqtt-broker"):
        broker = f"{host}:{PUBLIC_BROKER_PORT or MQTT_BROKER_PORT}"
    else:
        broker = f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}"
    # PS 用“下载到临时文件再 iex”：PS 5.1 的 iwr .Content 按 ANSI 解码致中文乱码，
    # 文件路径下 5.1/pwsh 7 均按 BOM 识别 UTF-8；临时文件与 AGENTBUS_INSTALL 由脚本 finally 清理
    ps_exec = f"iwr {origin}/install.ps1 -OutFile $env:AGENTBUS_INSTALL;iex $env:AGENTBUS_INSTALL"
    env_ps1 = (f"$env:AGENTBUS_INSTALL=\"$env:TEMP\\agentbus-install.ps1\";"
               f"$env:AGENTBUS_BROKER='{broker}';$env:AGENTBUS_USER='{user['username']}';"
               f"$env:AGENTBUS_PASSWORD='<密码>';$env:AGENTBUS_NS='{ns}';")
    env_sh = (f"AGENTBUS_BROKER='{broker}' AGENTBUS_USER='{user['username']}' "
              f"AGENTBUS_PASSWORD='<密码>' AGENTBUS_NS='{ns}' ")
    # 选了工具才注入 AGENTBUS_TOOLS（逗号分隔，脚本内展开为 init --tools）；不选则自动探测
    if tools:
        joined = ",".join(tools)
        env_ps1 += f"$env:AGENTBUS_TOOLS='{joined}';"
        env_sh += f"AGENTBUS_TOOLS='{joined}' "
    tools_flag = f" --tools {' '.join(tools)}" if tools else ""
    return JSONResponse({
        "broker": broker,
        "user": user["username"],
        "ns": ns,
        "tools": tools,
        "tools_options": tools_options,
        "template": f"agentbus init --yes --broker {broker} --user {user['username']} --password <密码> --ns {ns}{tools_flag}",
        "install_ps1": ps_exec,
        "install_sh": f"curl -fsSL {origin}/install.sh | bash",
        # sh 管道：env 前缀必须在 bash 前（而非 curl 前），否则管道中 bash 子进程收不到凭证
        "install_cmd_ps1": f"{env_ps1}{ps_exec}",
        "install_cmd_sh": f"curl -fsSL {origin}/install.sh | {env_sh}bash",
        "note": "命令含密码，注意 shell 历史",
    })


async def api_metrics(request: Request):
    """指标页：该 ns 下 Agent 在线概览（?ns= 必填，未授权 403）"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    if not ns:
        return _json_error("缺少 ns 参数")
    if not _ns_visible(user, ns):
        return _json_error("forbidden", 403)
    prefix = f"{ns}/"
    presence = _presence_store.snapshot()
    now = datetime.now(timezone.utc)
    return JSONResponse({
        "overview": {
            # TASK-33 DoD-4：统计卡与行内 Badge 同口径（agent_online，非 SSE 会话表）
            "online_agents": [k for k in presence if k.startswith(prefix) and agent_online(k, presence, now)],
            "registered_agents": [k for k, info in _agent_info.items()
                                  if info.registered and k.startswith(prefix)],
        },
    })


# api_metrics_summary 已废弃：metrics 已移除


# ─── TASK-31：Agent 明细（注册信息 × 在线状态 × daemon 指标 三源合并）───────

def build_agent_detail(ns: str, agent_info: Dict[str, Any], sessions: Dict[str, Any],
                       db_agents: Optional[Dict[str, dict]] = None,
                       now: Optional[datetime] = None,
                       presence: Optional[Dict[str, dict]] = None) -> List[dict]:
    """纯函数多源合并（便于单测）：key 取并集按 ns 前缀过滤，字典序稳定输出。

    - agent_info（_agent_info）→ name/description/capabilities/registered
    - sessions（_sessions）→ sse_connected（MCP SSE 会话存活，仅表示可调工具）
    - db_agents（TASK-32，按 client_id 索引的 agents 表行）→ 档案真源：
      tools/registered_at/owner/placeholder，并进 key 并集（仅有档案的也可见）
    - online（TASK-33）：presence 唯一真源 + 60s 心跳兜底
    """
    db_agents = db_agents or {}
    presence = presence or {}
    prefix = f"{ns}/"
    keys = sorted({k for k in list(agent_info) + list(sessions)
                   if k.startswith(prefix)}
                  | {f"{prefix}{cid}" for cid in db_agents})
    now = now or datetime.now(timezone.utc)
    out: List[dict] = []
    for k in keys:
        info = agent_info.get(k)
        row = db_agents.get(k[len(prefix):])
        out.append({
            "client_id": k[len(prefix):],
            "name": row["name"] if row else (info.name if info else None),
            "description": row["description"] if row else (info.description if info else None),
            "capabilities": (list(row["capabilities"]) if row
                             else (list(info.capabilities) if info else [])),
            "registered": bool(row) or bool(info and info.registered),
            "online": agent_online(k, presence, now),
            "sse_connected": k in sessions,
            "tools": list(row["tools"]) if row else [],
            "registered_at": row["created_at"] if row else (
                info.registered_at.isoformat() if info and info.registered_at else None),
            "owner": row["owner"] if row else "",
            "placeholder": bool(row) and not row["owner"] and row["name"] == row["client_id"],
        })
    return out


def _owner_display_names(owners) -> Dict[str, str]:
    """owner 用户名 → users.display_name 缓存查询（空 owner/无库返回空）"""
    if DB_CONN is None:
        return {}
    cache: Dict[str, str] = {}
    for o in owners:
        if o and o not in cache:
            u = hub_store.get_user(DB_CONN, o)
            cache[o] = u["display_name"] if u else ""
    return cache


async def api_console_agents(request: Request):
    """Agent 明细页：该 ns 下内存中的 Agent 信息（?ns= 必填，未授权 403）"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    if not ns:
        return _json_error("缺少 ns 参数")
    if not _ns_visible(user, ns):
        return _json_error("forbidden", 403)
    rows = build_agent_detail(ns, _agent_info, _sessions, None,
                              presence=_presence_store.snapshot())
    for r in rows:
        r.pop("owner", None)  # 不再需要 owner_display_name
    return JSONResponse({"agents": rows})


async def api_console_agent_patch(request: Request):
    """控制台编辑 Agent 档案（更新内存中的 _agent_info）。
    session_guard + _can_manage_ns；越权 403；无此 Agent 404；name 超 50 → 400。"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    cid = request.path_params.get("cid", "").strip()
    if not ns or not cid:
        return _json_error("缺少 ns/client_id")
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    if not isinstance(body, dict):
        return _json_error("请求体须为 JSON 对象")
    name = body.get("name")
    if isinstance(name, str) and len(name.strip()) > AGENT_NAME_MAX:
        return _json_error(f"name 长度须 ≤ {AGENT_NAME_MAX} 字符")
    
    key = f"{ns}/{cid}"
    info = _agent_info.get(key)
    if info is None:
        # Agent 未注册，自动创建
        info = AgentInfo(key)
        _agent_info[key] = info
    
    if isinstance(name, str) and name.strip():
        info.name = name.strip()
    if "description" in body:
        info.description = str(body["description"]).strip()
    caps = body.get("capabilities")
    if isinstance(caps, list):
        info.capabilities = [str(x).strip() for x in caps if str(x).strip()]
    
    logger.info(f"[agent-profile] console patched {ns}/{cid} by {user['username']}")
    _save_agent_db(key)
    return JSONResponse({"status": "updated", "client_id": cid})


async def api_console_agent_delete(request: Request):
    """删除 Agent 明细（0.2.10 best-effort）：DB 档案行有则删，内存态
    （指标/注册态/presence/存活 SSE 会话）全清；无档案也返回 200——有什么删什么。
    session_guard + _can_manage_ns；越权 403。
    注意：该身份若仍在线（daemon 在跑），下次指标上报会自动重建占位行——
    清理测试数据的正确姿势是先停对应 daemon 再删除。"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    cid = request.path_params.get("cid", "").strip()
    if not ns or not cid:
        return _json_error("缺少 ns/client_id")
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    key = session_key(cid, ns)
    # 持久化删除
    _delete_agent_db(key)
    _agent_info.pop(key, None)
    _presence_store.remove(key)
    session = _sessions.get(key)
    if session is not None:
        session.close()  # close 内部已从 _sessions/路由表摘除
    logger.info(f"[agent-profile] console deleted {ns}/{cid} by {user['username']}")
    return JSONResponse({"status": "deleted", "client_id": cid})


async def api_console_graph(request: Request):
    """Agent 沟通图谱：返回节点和边数据（?ns= 必填，?window_hours=1）"""
    user = hub_auth.current_user(request)
    ns = (request.query_params.get("ns") or "").strip()
    if not ns:
        return _json_error("缺少 ns 参数")
    if not _ns_visible(user, ns):
        return _json_error("forbidden", 403)
    try:
        window_hours = int(request.query_params.get("window_hours", "1"))
        if window_hours < 1:
            window_hours = 1
        elif window_hours > 24:
            window_hours = 24
    except ValueError:
        window_hours = 1
    graph = get_communication_graph(window_hours, ns=ns)
    return JSONResponse(graph)


# ─── TASK-32：Agent 档案注册（init HTTP 上报，Basic auth=broker 凭证） ─────────

AGENT_NAME_MAX = 50  # name 上限（应用层校验）


def _agent_basic_auth(request: Request) -> Optional[str]:
    """Basic auth（broker 凭证对 hub users 表校验）：通过返回 username，否则 None"""
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
    except Exception:
        return None
    username, _, password = decoded.partition(":")
    user = hub_store.get_user(DB_CONN, username) if DB_CONN is not None else None
    return username if hub_auth.login_ok(user, password) else None


async def api_agent_register(request: Request):
    """Agent 档案注册（幂等 upsert）：首写全字段，重跑只补空不覆盖。
    鉴权：Basic auth（鉴权 username 记为 owner）；MCP_API_TOKEN 配置时亦接受
    ?token=/Bearer（此通道 owner 留空）。name 超 50 → 400。"""
    owner = _agent_basic_auth(request)
    if owner is None:
        expected = os.getenv("MCP_API_TOKEN") or ""
        if not (expected and extract_token(request.scope) == expected):
            return _json_error("unauthorized（需 Basic auth 或 token）", 401)
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体须为 JSON 对象")
    if not isinstance(body, dict):
        return _json_error("请求体须为 JSON 对象")
    ns = str(body.get("ns") or "").strip()
    cid = str(body.get("client_id") or "").strip()
    name = str(body.get("name") or "").strip()
    if not ns or not cid:
        return _json_error("缺少 ns/client_id")
    if not name:
        return _json_error("缺少 name")
    if len(name) > AGENT_NAME_MAX:
        return _json_error(f"name 长度须 ≤ {AGENT_NAME_MAX} 字符")

    def _strlist(v):
        return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []

    # Agent 档案存内存（_agent_info），Web 控制台 build_agent_detail 由此读取
    key = session_key(cid, ns)
    info = _agent_info.get(key)
    if info is None:
        info = AgentInfo(cid)
        _agent_info[key] = info
    description = str(body.get("description") or "").strip()
    capabilities = _strlist(body.get("capabilities"))
    info.register(name, description, capabilities)
    _save_agent_db(key)
    logger.info(f"[agent-profile] registered {ns}/{cid} name={name!r} owner={owner or '(token)'}")
    return JSONResponse({"status": "registered", "client_id": cid})


async def api_agent_snapshot(request: Request):
    """TASK-32：ns 内全量 Agent 档案快照（daemon 轮询同步 agents.json 用）。
    鉴权同注册端点；online=agent_online 统一口径（presence 唯一真源 + 60s 心跳兜底）。"""
    owner = _agent_basic_auth(request)
    if owner is None:
        expected = os.getenv("MCP_API_TOKEN") or ""
        if not (expected and extract_token(request.scope) == expected):
            return _json_error("unauthorized（需 Basic auth 或 token）", 401)
    ns = (request.query_params.get("ns") or "").strip()
    if not ns:
        return _json_error("缺少 ns 参数")
    # 从内存读取 Agent 列表（不读 DB）
    # TASK-33：遍历 _agent_info（所有已注册 Agent），而非 _sessions（仅 SSE 连接）
    presence = _presence_store.snapshot()
    now = datetime.now(timezone.utc)
    agents = []
    for key, info in list(_agent_info.items()):
        if not key.startswith(f"{ns}/"):
            continue
        agents.append({
            "client_id": info.client_id,
            "name": info.name,
            "description": info.description,
            "capabilities": info.capabilities or [],
            "online": agent_online(key, presence, now),
        })
    return JSONResponse({"generated_at": now.isoformat(), "agents": agents})


# TASK-28：一键安装脚本托管（架构 6.6 / PLAN T24：中心节点静态服务，干净机器一条命令接入的下载源）
INSTALL_SCRIPTS = {
    "/install.ps1": (Path(__file__).resolve().parent / "scripts" / "install.ps1", "text/plain; charset=utf-8"),
    "/install.sh": (Path(__file__).resolve().parent / "scripts" / "install.sh", "text/plain; charset=utf-8"),
}


async def install_script(request: Request):
    path, media = INSTALL_SCRIPTS[request.url.path]
    if not path.exists():
        return JSONResponse({"error": f"安装脚本缺失（{path.name}）"}, status_code=500)
    body = path.read_bytes()
    if path.suffix == ".ps1" and not body.startswith(b"\xef\xbb\xbf"):
        # Windows PowerShell 5.1 无 BOM 时按 ANSI 解码（iwr .Content 还无视 charset），中文乱码；
        # BOM 是 5.1/pwsh 7 通用的 UTF-8 识别锚点
        body = b"\xef\xbb\xbf" + body
    return Response(body, media_type=media)


# 四期：Web 控制台构建产物目录（存在时才挂载 /console）
CONSOLE_DIST = Path(__file__).resolve().parent / "web" / "dist"


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
        # TASK-32：档案 hub 中心化（SQLite agents 表），断连不再清 _agent_info/注册态
        logger.info(f"[{key}] SSE disconnected")
    
    # SSE 流已在 connect_sse 内发送完毕，返回空响应避免 starlette 报 TypeError
    return Response(status_code=204)


# ─── 应用 ─────────────────────────────────────────────────────────────────────

# handle_post_message 本身是 ASGI 应用（自己发送 202 响应），必须用 Mount 挂载，
# 不能用 Route 包一层，否则 starlette 会尝试调用返回的 None 导致 TypeError
@asynccontextmanager
async def hub_lifespan(app):
    # 四期：账号体系初始化（SQLite + 超管引导 + dynsec 客户端），
    # 随后 TASK-24 共享 MQTT 连接随应用生命周期启停（含 TASK-19 metric 订阅）
    global _main_loop
    _main_loop = asyncio.get_running_loop()  # 捕获事件循环（供 on_message 线程安全调用）
    
    init_hub_state()
    global DYNSEC_CLIENT
    if DYNSEC_CLIENT is None:  # 测试可预置假客户端；生产在此注入共享连接发布函数
        DYNSEC_CLIENT = hub_dynsec.DynsecClient(publish_shared)
    start_shared_client()
    yield
    stop_shared_client()


app = Starlette(
    routes=[
        Route("/health", health),
        Route("/sse", sse_endpoint),
        Mount("/messages/", app=sse_transport.handle_post_message),
        # 四期：控制台 API v4（session 鉴权；403 由 handler 内显式返回）
        Route("/api/auth/login", hub_auth.session_guard(api_login), methods=["POST"]),
        Route("/api/auth/logout", hub_auth.session_guard(api_logout), methods=["POST"]),
        Route("/api/me", hub_auth.session_guard(api_me), methods=["GET"]),
        Route("/api/console/namespaces", hub_auth.session_guard(api_ns_list), methods=["GET"]),
        Route("/api/console/namespaces", hub_auth.session_guard(api_ns_create), methods=["POST"]),
        Route("/api/console/namespaces/{ns}", hub_auth.session_guard(api_ns_delete), methods=["DELETE"]),
        Route("/api/console/namespaces/{ns}", hub_auth.session_guard(api_ns_update), methods=["PATCH"]),
        Route("/api/console/namespaces/{ns}/members/{username}", hub_auth.session_guard(api_member_put), methods=["PUT"]),
        Route("/api/console/namespaces/{ns}/members/{username}", hub_auth.session_guard(api_member_delete), methods=["DELETE"]),
        Route("/api/console/accounts", hub_auth.session_guard(api_accounts_list), methods=["GET"]),
        Route("/api/console/accounts/search", hub_auth.session_guard(api_accounts_search), methods=["GET"]),
        Route("/api/console/accounts", hub_auth.session_guard(api_account_create), methods=["POST"]),
        Route("/api/console/accounts/{username}", hub_auth.session_guard(api_account_delete), methods=["DELETE"]),
        Route("/api/console/accounts/{username}", hub_auth.session_guard(api_account_update), methods=["PATCH"]),
        Route("/api/console/accounts/{username}/password", hub_auth.session_guard(api_account_password), methods=["POST"]),
        Route("/api/console/connect-command", hub_auth.session_guard(api_connect_command), methods=["GET"]),
        Route("/api/console/metrics", hub_auth.session_guard(api_metrics), methods=["GET"]),
        Route("/api/console/agents", hub_auth.session_guard(api_console_agents), methods=["GET"]),
        Route("/api/console/agents/{cid}", hub_auth.session_guard(api_console_agent_patch), methods=["PATCH"]),
        Route("/api/console/agents/{cid}", hub_auth.session_guard(api_console_agent_delete), methods=["DELETE"]),
        Route("/api/console/graph", hub_auth.session_guard(api_console_graph), methods=["GET"]),
        # TASK-32：Agent 档案注册（Basic auth=broker 凭证；不走 session 鉴权）
        Route("/api/agent/register", api_agent_register, methods=["POST"]),
        Route("/api/agent/snapshot", api_agent_snapshot, methods=["GET"]),
        # TASK-28：一键安装脚本（引导资源，鉴权豁免）
        Route("/install.ps1", install_script, methods=["GET"]),
        Route("/install.sh", install_script, methods=["GET"]),
    ]
    + (
        # 四期：Web 控制台静态托管（web/dist 构建产物，html=True 提供 SPA 入口）
        [Mount("/console", app=StaticFiles(directory=str(CONSOLE_DIST), html=True))]
        if CONSOLE_DIST.exists()
        else []
    ),
    lifespan=hub_lifespan,
)


# ─── TASK-25：MCP 通道接入鉴权（安全基线） ───────────────────────────────────
# 契约（四期收窄）：MCP_API_TOKEN 非空时启用——仅 /sse 与 /messages/*（MCP 通道）
# 须携带 ?token= 或 Authorization: Bearer；控制台 API 走 session 鉴权（hub/auth），
# 与本中间件互不影响。/health 与 /install.*（引导资源，装机时尚无 token）开放；
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
        if (
            scope["type"] != "http"
            or path.startswith("/health")
            or path.startswith("/install.")
            or not expected
            or not (path.startswith("/sse") or path.startswith("/messages/"))
        ):
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
