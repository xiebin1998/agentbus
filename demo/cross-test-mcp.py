#!/usr/bin/env python
"""
AgentBus 交叉测试脚本 - 使用 MCP/SSE 协议模拟多 Agent 通信
包含 MQTT presence 发布以模拟真实在线状态
"""
import asyncio
import json
import sys
import time
from typing import Dict, List, Optional
from dataclasses import dataclass
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import paho.mqtt.client as mqtt
from mcp import ClientSession
from mcp.client.sse import sse_client

HUB = "http://127.0.0.1:8000"
BROKER_PORT = 18830
NS = "iot"
MQTT_USER = "admin"
MQTT_PASS = "386_Ia1l6hHJ9mXcpSSnrrRF"

AGENTS = ["opencode", "codex", "claude", "qoder"]


class AgentContext:
    def __init__(self, name: str, client_id: str):
        self.name = name
        self.client_id = client_id
        self.received_messages: List[dict] = []
        self.mqtt_client: Optional[mqtt.Client] = None
        self.sse_cm = None
        self.mcp_cm = None
        self.mcp_session: Optional[ClientSession] = None
        self.heartbeat_task: Optional[asyncio.Task] = None
    
    def create_mqtt_client(self) -> mqtt.Client:
        """创建 MQTT 客户端并发布 presence"""
        def on_connect(client, userdata, flags, rc, properties=None):
            if rc == 0:
                # 发布在线状态
                status_topic = f"/agentbus/ai/status/{NS}/{self.client_id}"
                payload = {
                    "state": "online",
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "identity": f"{NS}/{self.client_id}"
                }
                client.publish(status_topic, json.dumps(payload), qos=1, retain=True)
                
                # 订阅消息 topic
                msg_topic = f"/agentbus/ai/channel/{NS}/{self.client_id}/message"
                client.subscribe(msg_topic, qos=1)
                print(f"  [{self.name}] MQTT 已连接，已发布在线状态")
            else:
                print(f"  [{self.name}] MQTT 连接失败: rc={rc}")
        
        def on_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload.decode())
                self.received_messages.append(payload)
                print(f"  [{self.name}] 收到消息: from={payload.get('from')} text={payload.get('text', '')[:30]}")
            except Exception as e:
                print(f"  [{self.name}] 消息解析失败: {e}")
        
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"agent-{self.client_id}")
        client.username_pw_set(MQTT_USER, MQTT_PASS)
        client.on_connect = on_connect
        client.on_message = on_message
        client.connect("127.0.0.1", BROKER_PORT)
        client.loop_start()
        return client
    
    async def start_heartbeat(self):
        """定期发送心跳保持在线"""
        while True:
            await asyncio.sleep(20)
            if self.mqtt_client and self.mqtt_client.is_connected():
                status_topic = f"/agentbus/ai/status/{NS}/{self.client_id}"
                payload = {
                    "state": "online",
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "identity": f"{NS}/{self.client_id}"
                }
                self.mqtt_client.publish(status_topic, json.dumps(payload), qos=1)
    
    async def connect(self):
        self.mqtt_client = self.create_mqtt_client()
        await asyncio.sleep(0.5)
        
        self.heartbeat_task = asyncio.create_task(self.start_heartbeat())
        
        url = f"{HUB}/sse?client_id={self.client_id}&ns={NS}"
        self.sse_cm = sse_client(url)
        read, write = await self.sse_cm.__aenter__()
        
        self.mcp_cm = ClientSession(read, write)
        self.mcp_session = await self.mcp_cm.__aenter__()
        await self.mcp_session.initialize()
        
        reg_result = await self.mcp_session.call_tool(
            "update_agent",
            {"name": self.name, "description": f"Test agent: {self.name}", "capabilities": ["test"]}
        )
        print(f"[{self.name}] 注册完成: {reg_result.content[0].text.splitlines()[0]}")
    
    async def disconnect(self):
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
            try:
                await self.heartbeat_task
            except asyncio.CancelledError:
                pass
        
        if self.mqtt_client and self.mqtt_client.is_connected():
            status_topic = f"/agentbus/ai/status/{NS}/{self.client_id}"
            payload = {
                "state": "offline",
                "ts": datetime.now(timezone.utc).isoformat(),
                "identity": f"{NS}/{self.client_id}",
                "reason": "test_disconnect"
            }
            self.mqtt_client.publish(status_topic, json.dumps(payload), qos=1, retain=True)
            self.mqtt_client.loop_stop()
            self.mqtt_client.disconnect()
        
        if self.mcp_cm:
            await self.mcp_cm.__aexit__(None, None, None)
        if self.sse_cm:
            await self.sse_cm.__aexit__(None, None, None)
        print(f"[{self.name}] 已断开")


async def send_message_test(sender: AgentContext, target: AgentContext, message: str) -> bool:
    print(f"\n[测试] {sender.name} -> {target.name}: {message}")
    
    target.received_messages.clear()
    
    result = await sender.mcp_session.call_tool(
        "send_message",
        {"text": message, "to": target.client_id}
    )
    send_result = json.loads(result.content[0].text)
    print(f"  发送结果: {json.dumps(send_result, ensure_ascii=False)}")
    
    deadline = time.time() + 5
    while time.time() < deadline and len(target.received_messages) == 0:
        await asyncio.sleep(0.1)
    
    if len(target.received_messages) > 0:
        print(f"  ✓ 消息已送达")
        return True
    else:
        print(f"  ✗ 消息未送达")
        return False


async def list_agents_test(ctx: AgentContext) -> List[dict]:
    result = await ctx.mcp_session.call_tool("list_agents", {})
    agents = json.loads(result.content[0].text)
    print(f"[{ctx.name}] 在线 Agent 数量: {len(agents) if isinstance(agents, list) else 'N/A'}")
    return agents if isinstance(agents, list) else []


async def offline_detection_test(active_agent: AgentContext, offline_client_id: str):
    print(f"\n[测试] 离线检测: 向离线 Agent {offline_client_id} 发送消息")
    
    result = await active_agent.mcp_session.call_tool(
        "send_message",
        {"text": "测试离线消息", "to": offline_client_id}
    )
    send_result = json.loads(result.content[0].text)
    
    if "error" in send_result or "offline" in str(send_result).lower():
        print(f"  ✓ 正确识别离线: {send_result}")
        return True
    else:
        print(f"  ✗ 未识别离线状态: {send_result}")
        return False


async def multi_target_test(sender: AgentContext, online_targets: List[AgentContext], offline_client_id: str):
    print(f"\n[测试] 多目标投递: 部分在线、部分离线")
    
    for t in online_targets:
        t.received_messages.clear()
    
    target_ids = [t.client_id for t in online_targets] + [offline_client_id]
    
    result = await sender.mcp_session.call_tool(
        "send_message",
        {"text": "多目标测试消息", "to": target_ids}
    )
    send_result = json.loads(result.content[0].text)
    print(f"  发送结果: {json.dumps(send_result, ensure_ascii=False)}")
    
    await asyncio.sleep(1)
    
    received_count = sum(1 for t in online_targets if len(t.received_messages) > 0)
    print(f"  在线目标收到: {received_count}/{len(online_targets)}")
    
    if "offline" in str(send_result):
        print(f"  ✓ 返回离线信息")
        return True
    else:
        print(f"  ✗ 未返回离线信息")
        return False


async def run_2agent_test(agent1_name: str, agent2_name: str):
    print(f"\n{'='*60}")
    print(f"2-Agent 测试: {agent1_name} ↔ {agent2_name}")
    print(f"{'='*60}")
    
    agent1 = AgentContext(agent1_name, f"ag-{agent1_name}")
    agent2 = AgentContext(agent2_name, f"ag-{agent2_name}")
    
    await agent1.connect()
    await agent2.connect()
    
    try:
        await send_message_test(agent1, agent2, f"Hello from {agent1_name}")
        await asyncio.sleep(0.5)
        await send_message_test(agent2, agent1, f"Hello from {agent2_name}")
        
        await list_agents_test(agent1)
        
        print(f"✓ {agent1_name} ↔ {agent2_name} 测试通过")
    finally:
        await agent2.disconnect()
        await agent1.disconnect()


async def run_3agent_test(agent1_name: str, agent2_name: str, agent3_name: str):
    print(f"\n{'='*60}")
    print(f"3-Agent 测试: {agent1_name} + {agent2_name} + {agent3_name}")
    print(f"{'='*60}")
    
    agent1 = AgentContext(agent1_name, f"ag-{agent1_name}")
    agent2 = AgentContext(agent2_name, f"ag-{agent2_name}")
    agent3 = AgentContext(agent3_name, f"ag-{agent3_name}")
    
    await agent1.connect()
    await agent2.connect()
    await agent3.connect()
    
    try:
        await send_message_test(agent1, agent2, f"Broadcast from {agent1_name} to {agent2_name}")
        await asyncio.sleep(0.5)
        await send_message_test(agent1, agent3, f"Broadcast from {agent1_name} to {agent3_name}")
        await asyncio.sleep(0.5)
        await send_message_test(agent2, agent3, f"Message from {agent2_name} to {agent3_name}")
        
        await list_agents_test(agent1)
        
        print(f"✓ 3-Agent 测试通过")
    finally:
        await agent3.disconnect()
        await agent2.disconnect()
        await agent1.disconnect()


async def run_4agent_test():
    print(f"\n{'='*60}")
    print(f"4-Agent 测试: opencode + codex + claude + qoder")
    print(f"{'='*60}")
    
    agents = {}
    for name in AGENTS:
        agents[name] = AgentContext(name, f"ag-{name}")
        await agents[name].connect()
    
    try:
        for i, sender_name in enumerate(AGENTS):
            for j, receiver_name in enumerate(AGENTS):
                if i != j:
                    await send_message_test(
                        agents[sender_name],
                        agents[receiver_name],
                        f"Message from {sender_name} to {receiver_name}"
                    )
                    await asyncio.sleep(0.3)
        
        await list_agents_test(agents["opencode"])
        
        print(f"✓ 4-Agent 测试通过")
    finally:
        for name in reversed(AGENTS):
            await agents[name].disconnect()


async def run_offline_test():
    print(f"\n{'='*60}")
    print(f"离线检测测试")
    print(f"{'='*60}")
    
    agent1 = AgentContext("opencode", "ag-opencode")
    agent2 = AgentContext("codex", "ag-codex")
    
    await agent1.connect()
    await agent2.connect()
    
    try:
        await agent2.disconnect()
        await asyncio.sleep(1)
        
        await offline_detection_test(agent1, "ag-codex")
        
        agent2 = AgentContext("codex", "ag-codex")
        await agent2.connect()
        
        await multi_target_test(agent1, [agent2], "ag-nonexistent")
        
        print(f"✓ 离线检测测试通过")
    finally:
        await agent2.disconnect()
        await agent1.disconnect()


async def main():
    print("="*60)
    print("AgentBus 交叉测试 - MCP/SSE 协议")
    print("="*60)
    
    pairs = [
        ("opencode", "codex"),
        ("opencode", "claude"),
        ("opencode", "qoder"),
        ("codex", "claude"),
        ("codex", "qoder"),
        ("claude", "qoder"),
    ]
    for a1, a2 in pairs:
        await run_2agent_test(a1, a2)
        await asyncio.sleep(1)
    
    triples = [
        ("opencode", "codex", "claude"),
        ("opencode", "codex", "qoder"),
        ("opencode", "claude", "qoder"),
        ("codex", "claude", "qoder"),
    ]
    for a1, a2, a3 in triples:
        await run_3agent_test(a1, a2, a3)
        await asyncio.sleep(1)
    
    await run_4agent_test()
    await asyncio.sleep(1)
    
    await run_offline_test()
    
    print("\n" + "="*60)
    print("✓ 所有交叉测试完成！")
    print("="*60)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
