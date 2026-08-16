#!/usr/bin/env python
"""
AgentBus 交叉测试脚本 - 简化版
使用 HTTP API + MCP 工具模拟多 Agent 通信
"""
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from typing import List, Dict

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import requests
from starlette.testclient import TestClient

# Import server
sys.path.insert(0, r"D:\workSpase\Python\agentbus")
import server

HUB_URL = "http://127.0.0.1:8000"
NS = "test"

class AgentSimulator:
    """模拟一个 Agent"""
    def __init__(self, name: str, ns: str = NS):
        self.name = name
        self.ns = ns
        self.client_id = f"{ns}/{name}"
        self.received_messages = []
        self.session = None
        
    def register(self):
        """注册 Agent"""
        # 创建 session
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        srv = server.create_mcp_server(self.name, self.ns)
        key = f"{self.ns}/{self.name}"
        server._sessions[key].mcp_session = object()
        server._sessions[key].info.name = self.name
        server._sessions[key].info.registered = True
        # Mark MQTT as ready to bypass connection check
        server._shared_ready.set()
        
        # 更新 presence
        now = datetime.now(timezone.utc).isoformat()
        server._presence_store.update(key, "online", now, reason="test")
        
        # 更新 metrics
        server._metrics_store.update(key, {"injected_ok": 1}, now)
        
        self.session = server._sessions[key]
        print(f"  [{self.name}] 已注册并上线")
        
    async def send_message(self, to: str, text: str):
        """发送消息"""
        from mcp import types
        
        srv = server.create_mcp_server(self.name, self.ns)
        handler = srv.request_handlers[types.CallToolRequest]
        req = types.CallToolRequest(
            method="tools/call",
            params=types.CallToolRequestParams(
                name="send_message",
                arguments={"text": text, "to": to}
            )
        )
        result = await handler(req)
        response = json.loads(result.root.content[0].text)
        print(f"  [{self.name}] -> {to}: {text[:30]}... => {response.get('status', 'error')}")
        return response
        
    async def list_agents(self):
        """列出所有 Agent"""
        from mcp import types
        
        srv = server.create_mcp_server(self.name, self.ns)
        handler = srv.request_handlers[types.CallToolRequest]
        req = types.CallToolRequest(
            method="tools/call",
            params=types.CallToolRequestParams(name="list_agents", arguments={})
        )
        result = await handler(req)
        agents = json.loads(result.root.content[0].text)
        return agents
        
    def go_offline(self):
        """模拟离线"""
        key = f"{self.ns}/{self.name}"
        server._presence_store.remove(key)
        print(f"  [{self.name}] 已离线")


async def test_2_agent_communication():
    """测试 2-Agent 通信"""
    print("\n=== 测试 1: 2-Agent 通信 ===")
    
    agents = [
        AgentSimulator("alice"),
        AgentSimulator("bob"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.5)
    
    # Alice 发送给 Bob
    result = await agents[0].send_message("bob", "Hello from Alice!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # Bob 发送给 Alice
    result = await agents[1].send_message("alice", "Hi from Bob!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    print("✓ 2-Agent 通信测试通过")
    
    # 清理
    for agent in agents:
        key = f"{agent.ns}/{agent.name}"
        server._presence_store.remove(key)
        server._metrics_store.remove(key)
        server._sessions.pop(key, None)
        server._agent_info.pop(key, None)


async def test_3_agent_communication():
    """测试 3-Agent 通信"""
    print("\n=== 测试 2: 3-Agent 通信 ===")
    
    agents = [
        AgentSimulator("charlie"),
        AgentSimulator("david"),
        AgentSimulator("eve"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.5)
    
    # Charlie 发送给 David 和 Eve
    result = await agents[0].send_message(["david", "eve"], "Hello from Charlie!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # David 发送给 Charlie
    result = await agents[1].send_message("charlie", "Hi from David!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # Eve 发送给 Charlie 和 David
    result = await agents[2].send_message(["charlie", "david"], "Greetings from Eve!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    print("✓ 3-Agent 通信测试通过")
    
    # 清理
    for agent in agents:
        key = f"{agent.ns}/{agent.name}"
        server._presence_store.remove(key)
        server._metrics_store.remove(key)
        server._sessions.pop(key, None)
        server._agent_info.pop(key, None)


async def test_4_agent_communication():
    """测试 4-Agent 通信"""
    print("\n=== 测试 3: 4-Agent 通信 ===")
    
    agents = [
        AgentSimulator("frank"),
        AgentSimulator("grace"),
        AgentSimulator("henry"),
        AgentSimulator("iris"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.5)
    
    # Frank 发送给所有其他 Agent
    result = await agents[0].send_message(
        ["grace", "henry", "iris"],
        "Hello everyone from Frank!"
    )
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # Grace 发送给 Frank 和 Henry
    result = await agents[1].send_message(
        ["frank", "henry"],
        "Hi from Grace!"
    )
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # Henry 发送给所有
    result = await agents[2].send_message(
        ["frank", "grace", "iris"],
        "Greetings from Henry!"
    )
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # Iris 发送给 Frank
    result = await agents[3].send_message("frank", "Hello from Iris!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    print("✓ 4-Agent 通信测试通过")
    
    # 清理
    for agent in agents:
        key = f"{agent.ns}/{agent.name}"
        server._presence_store.remove(key)
        server._metrics_store.remove(key)
        server._sessions.pop(key, None)
        server._agent_info.pop(key, None)


async def test_offline_detection():
    """测试离线检测"""
    print("\n=== 测试 4: 离线检测 ===")
    
    agents = [
        AgentSimulator("online1"),
        AgentSimulator("online2"),
        AgentSimulator("offline1"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.5)
    
    # 让 offline1 离线
    agents[2].go_offline()
    
    await asyncio.sleep(0.5)
    
    # online1 尝试发送给 offline1，应该被拒绝
    result = await agents[0].send_message("offline1", "Are you there?")
    assert "error" in result or "offline_targets" in result, f"应该拒发给离线目标: {result}"
    print(f"  ✓ 离线目标被正确拒绝: {result.get('offline_targets', [])}")
    
    # online1 发送给 online2，应该成功
    result = await agents[0].send_message("online2", "Hello!")
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    # 列出 Agent，检查在线状态
    agent_list = await agents[0].list_agents()
    online_count = sum(1 for a in agent_list if a.get("mqtt_connected"))
    print(f"  在线 Agent 数量: {online_count}")
    
    print("✓ 离线检测测试通过")
    
    # 清理
    for agent in agents:
        key = f"{agent.ns}/{agent.name}"
        server._presence_store.remove(key)
        server._metrics_store.remove(key)
        server._sessions.pop(key, None)
        server._agent_info.pop(key, None)


async def test_mixed_online_offline():
    """测试混合在线离线场景"""
    print("\n=== 测试 5: 混合在线离线场景 ===")
    
    agents = [
        AgentSimulator("sender"),
        AgentSimulator("receiver1"),
        AgentSimulator("receiver2"),
        AgentSimulator("offline_receiver"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.5)
    
    # 让一个接收者离线
    agents[3].go_offline()
    
    await asyncio.sleep(0.5)
    
    # 尝试发送给多个目标（包括离线），应该整体拒发
    result = await agents[0].send_message(
        ["receiver1", "receiver2", "offline_receiver"],
        "Hello everyone!"
    )
    assert "error" in result or "offline_targets" in result, f"应该拒发: {result}"
    print(f"  ✓ 混合场景正确拒发: {result.get('offline_targets', [])}")
    
    # 只发送给在线目标，应该成功
    result = await agents[0].send_message(
        ["receiver1", "receiver2"],
        "Hello online friends!"
    )
    assert result.get("status") == "sent", f"消息发送失败: {result}"
    
    print("✓ 混合在线离线场景测试通过")
    
    # 清理
    for agent in agents:
        key = f"{agent.ns}/{agent.name}"
        server._presence_store.remove(key)
        server._metrics_store.remove(key)
        server._sessions.pop(key, None)
        server._agent_info.pop(key, None)



def setup_mock_mqtt():
    """设置模拟 MQTT 客户端"""
    from unittest.mock import MagicMock
    from types import SimpleNamespace
    
    # 创建模拟 MQTT 客户端
    mock_client = MagicMock()
    mock_client.is_connected.return_value = True
    mock_client.publish.return_value = SimpleNamespace(rc=0)
    mock_client.subscribe.return_value = (0, 1)
    
    server._shared_client = mock_client
    server._shared_ready.set()
    print("✓ 模拟 MQTT 客户端已设置")


async def main():
    """主测试函数"""
    print("=" * 60)
    print("AgentBus 交叉测试")
    print("=" * 60)
    
    # 清空状态
    server._sessions.clear()
    server._agent_info.clear()
    server._presence_store._data.clear()
    server._metrics_store._data.clear()
    
    try:
        await test_2_agent_communication()
        await test_3_agent_communication()
        await test_4_agent_communication()
        await test_offline_detection()
        await test_mixed_online_offline()
        
        print("\n" + "=" * 60)
        print("✓ 所有交叉测试通过！")
        print("=" * 60)
        
    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    setup_mock_mqtt()
    asyncio.run(main())
