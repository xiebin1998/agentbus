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
import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Dict, List, Union

import paho.mqtt.client as mqtt
from mcp.server import Server
from mcp.server.session import ServerSession
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent
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
    
    def __init__(self, client_id: str, event_loop: asyncio.AbstractEventLoop):
        self.client_id = client_id
        self.loop = event_loop
        self.connected = False
        self.mcp_server: Optional[Server] = None
        self.mcp_session: Optional[ServerSession] = None
        self.sub_topic = TOPIC_MESSAGE.format(client_id=client_id)
        
        self.info = AgentInfo(client_id)
        _agent_info[client_id] = self.info
        
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
            logger.info(f"[{self.client_id}] MQTT connected, subscribed to {self.sub_topic}")
        else:
            logger.error(f"[{self.client_id}] MQTT connect failed: rc={rc}")
    
    def _on_disconnect(self, client, userdata, flags, rc, properties=None):
        self.connected = False
        logger.warning(f"[{self.client_id}] MQTT disconnected (rc={rc})")
    
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
        
        targets = [to] if isinstance(to, str) else to
        
        # ★ 构建消息格式（兼容 qwenpaw）★
        payload = {
            "id": msg_id,
            "from": self.client_id,                    # 标准字段
            "redirect_client_id": self.client_id,      # 兼容 qwenpaw
            "to": to,
            "text": text,
            "type": msg_type,
            "timestamp": timestamp,
        }
        
        sent_to = []
        for target in targets:
            pub_topic = TOPIC_MESSAGE.format(client_id=target)
            self.mqtt.publish(pub_topic, json.dumps(payload, ensure_ascii=False), qos=2)
            sent_to.append(target)
            logger.info(f"[{self.client_id}] Published to {pub_topic}")
        
        self.info.last_active = datetime.now(timezone.utc)
        _messages[msg_id] = payload
        
        return {
            "status": "sent",
            "id": msg_id,
            "to": sent_to,
        }
    
    def close(self):
        self.mqtt.loop_stop()
        self.mqtt.disconnect()
        logger.info(f"[{self.client_id}] Session closed")


# ─── MCP Server 创建 ──────────────────────────────────────────────────────────

def create_mcp_server(client_id: str) -> Server:
    server = Server(f"agent-{client_id}")
    
    loop = asyncio.get_event_loop()
    if client_id not in _sessions:
        session = AgentSession(client_id, loop)
        session.start()
        _sessions[client_id] = session
    else:
        session = _sessions[client_id]
    
    session.mcp_server = server
    _servers[client_id] = server
    
    logger.info(f"[{client_id}] MCP Server created")
    
    @server.list_tools()
    async def list_tools() -> List[Tool]:
        # 首次请求时捕获会话，供 MQTT 线程跨上下文推送使用
        if session.mcp_session is None:
            session.mcp_session = server.request_context.session
        return [
            Tool(
                name="register_agent",
                description="注册 Agent 信息。必须先注册才能发送消息。",
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
                description="更新 Agent 能力信息",
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
                description="发送消息给指定 Agent。需要先调用 register_agent 注册。",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "消息内容"},
                        "to": {"type": ["string", "array"], "description": "目标 Agent 的 client_id"},
                        "type": {"type": "string", "default": "text"},
                    },
                    "required": ["text", "to"],
                },
            ),
            Tool(
                name="ack_message",
                description="确认收到消息",
                inputSchema={
                    "type": "object",
                    "properties": {"id": {"type": "string", "description": "消息 ID"}},
                    "required": ["id"],
                },
            ),
            Tool(
                name="list_agents",
                description="列出所有在线 Agent 及其能力",
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="get_agent_info",
                description="查询指定 Agent 的详细信息",
                inputSchema={
                    "type": "object",
                    "properties": {"client_id": {"type": "string"}},
                    "required": ["client_id"],
                },
            ),
            Tool(
                name="find_agents_by_capability",
                description="按能力查找 Agent",
                inputSchema={
                    "type": "object",
                    "properties": {"capability": {"type": "string", "description": "要查找的能力"}},
                    "required": ["capability"],
                },
            ),
            Tool(
                name="get_status",
                description="获取当前 Agent 状态",
                inputSchema={"type": "object", "properties": {}},
            ),
        ]
    
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
            
            targets = [to] if isinstance(to, str) else to
            offline = [t for t in targets if t not in _sessions]
            if offline:
                return [TextContent(type="text", text=json.dumps({
                    "error": f"Agents not online: {offline}",
                    "online_agents": list(_sessions.keys()),
                }, ensure_ascii=False, indent=2))]
            
            result = session.send_message(text, to, msg_type)
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
        
        elif name == "ack_message":
            msg_id = arguments["id"]
            if msg_id in _messages:
                _messages[msg_id]["acknowledged"] = True
                _messages[msg_id]["acknowledged_at"] = datetime.now(timezone.utc).isoformat()
                logger.info(f"[{client_id}] Acknowledged: {msg_id}")
                return [TextContent(type="text", text=json.dumps({"status": "acknowledged", "id": msg_id}, indent=2))]
            return [TextContent(type="text", text=json.dumps({"error": "Unknown message id"}, indent=2))]
        
        elif name == "list_agents":
            agents = []
            for cid, sess in _sessions.items():
                info = sess.info.to_dict()
                info["mqtt_connected"] = sess.connected
                agents.append(info)
            return [TextContent(type="text", text=json.dumps(agents, ensure_ascii=False, indent=2))]
        
        elif name == "get_agent_info":
            target = arguments["client_id"]
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
    return JSONResponse({
        "status": "ok",
        "service": "agentbus-hub",
        "mqtt_broker": f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}",
        "online_agents": list(_sessions.keys()),
        "registered_agents": [cid for cid, info in _agent_info.items() if info.registered],
        "total_messages": len(_messages),
    })


async def sse_endpoint(request: Request):
    client_id = request.query_params.get("client_id") or request.headers.get("x-client-id", "")
    
    if not client_id:
        return JSONResponse({"error": "client_id required"}, status_code=400)
    
    logger.info(f"[{client_id}] SSE connecting...")
    
    mcp_server = create_mcp_server(client_id)
    
    try:
        async with sse_transport.connect_sse(request.scope, request.receive, request._send) as streams:
            logger.info(f"[{client_id}] SSE connected")
            await mcp_server.run(streams[0], streams[1], mcp_server.create_initialization_options())
    except Exception as e:
        logger.error(f"[{client_id}] SSE error: {e}")
    finally:
        if client_id in _sessions:
            _sessions[client_id].close()
            del _sessions[client_id]
        _servers.pop(client_id, None)
        logger.info(f"[{client_id}] SSE disconnected")
    
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
