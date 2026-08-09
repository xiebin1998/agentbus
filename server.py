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
import threading
import uuid
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
MCP_HOST = os.getenv("MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.getenv("MCP_PORT", "8000"))

# ─── Topic ────────────────────────────────────────────────────────────────────
TOPIC_MESSAGE = "/phnix/ai/channel/{client_id}/message"

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


# ─── Agent Session ───────────────────────────────────────────────────────────

class AgentSession:
    """单个 Agent 的会话"""
    
    def __init__(self, client_id: str, event_loop: asyncio.AbstractEventLoop, ns: Optional[str] = None):
        self.client_id = client_id
        self.ns = ns
        self.key = session_key(client_id, ns)
        self.loop = event_loop
        self.connected = False
        # TASK-13 冒烟缺陷：SSE 握手返回时 MQTT 订阅可能未完成，早到回复会丢失；
        # 用就绪事件门控 send_message，确保自身收件 topic 已订阅
        self.ready = threading.Event()
        self.mcp_server: Optional[Server] = None
        self.mcp_session: Optional[ServerSession] = None
        self.sub_topic = build_sub_topic(client_id, ns)
        
        self.info = AgentInfo(self.key)
        _agent_info[self.key] = self.info
        
        mqtt_id = f"agent-{client_id}-{uuid.uuid4().hex[:8]}"
        self.mqtt = mqtt.Client(
            client_id=mqtt_id,
            protocol=mqtt.MQTTv311,
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        )
        
        if MQTT_USERNAME:
            self.mqtt.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        if MQTT_USE_TLS:
            self.mqtt.tls_set()
        
        self.mqtt.on_connect = self._on_connect
        self.mqtt.on_disconnect = self._on_disconnect
        self.mqtt.on_message = self._on_message
    
    def is_registered(self) -> bool:
        return self.info.registered
    
    def start(self):
        self.mqtt.loop_start()
        try:
            self.mqtt.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, keepalive=60)
            logger.info(f"[{self.client_id}] MQTT connecting to {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}")
        except Exception as e:
            logger.error(f"[{self.client_id}] MQTT connect failed: {e}")
    
    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            self.connected = True
            self.mqtt.subscribe(self.sub_topic, qos=2)
            self.ready.set()
            logger.info(f"[{self.client_id}] MQTT connected, subscribed to {self.sub_topic}")
        else:
            logger.error(f"[{self.client_id}] MQTT connect failed: rc={rc}")
    
    def _on_disconnect(self, client, userdata, flags, rc, properties=None):
        self.connected = False
        self.ready.clear()
        logger.warning(f"[{self.client_id}] MQTT disconnected (rc={rc})")
    
    def is_mqtt_ready(self) -> bool:
        return self.ready.is_set()
    
    def wait_ready(self, timeout: float = 5.0) -> bool:
        """阻塞等待 MQTT 建连 + 订阅就绪（供调用方在线程中等待）"""
        return self.ready.wait(timeout)
    
    def _on_message(self, client, userdata, msg):
        """收到 MQTT 消息时触发"""
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except json.JSONDecodeError:
            logger.error(f"[{self.client_id}] Invalid JSON: {msg.payload}")
            return
        
        # 兼容 qwenpaw：redirect_client_id 或 from 字段
        sender = payload.get("redirect_client_id") or payload.get("from", "?")
        text = payload.get("text", "")
        logger.info(f"[{self.client_id}] Received from [{sender}]: {text[:50]}")
        
        asyncio.run_coroutine_threadsafe(
            self._push_to_mcp(payload),
            self.loop
        )
    
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
        for pub_topic in pub_topics:
            self.mqtt.publish(pub_topic, message_json, qos=2)
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
        self.mqtt.loop_stop()
        self.mqtt.disconnect()
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
    })


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
            _sessions[key].close()
            del _sessions[key]
        _servers.pop(key, None)
        # 断线清理（11.8 缺陷 2）：会话消失后同步移除元信息，防止 _agent_info 泄漏
        _agent_info.pop(key, None)
        logger.info(f"[{key}] SSE disconnected")
    
    # SSE 流已在 connect_sse 内发送完毕，返回空响应避免 starlette 报 TypeError
    return Response(status_code=204)


# ─── 应用 ─────────────────────────────────────────────────────────────────────

# handle_post_message 本身是 ASGI 应用（自己发送 202 响应），必须用 Mount 挂载，
# 不能用 Route 包一层，否则 starlette 会尝试调用返回的 None 导致 TypeError
app = Starlette(routes=[
    Route("/health", health),
    Route("/sse", sse_endpoint),
    Mount("/messages/", app=sse_transport.handle_post_message),
])


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
        uvicorn.run(app, host=MCP_HOST, port=MCP_PORT)
