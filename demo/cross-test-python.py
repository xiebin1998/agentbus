#!/usr/bin/env python3
"""
Cross-Agent Test using MCP Client
Tests message passing between multiple agents via SSE/MCP
"""
import asyncio
import json
import sys
import time
from pathlib import Path

# Windows console UTF-8
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import paho.mqtt.client as mqtt
from mcp import ClientSession
from mcp.client.sse import sse_client

HUB = "http://127.0.0.1:8000"
BROKER_PORT = 18830
NS = "iot"

# Test agents
AGENTS = [
    {"id": "test-agent-a", "name": "Agent A"},
    {"id": "test-agent-b", "name": "Agent B"},
    {"id": "test-agent-c", "name": "Agent C"},
    {"id": "test-agent-d", "name": "Agent D"},
]

received_messages = {agent["id"]: [] for agent in AGENTS}


def start_verifier(agent_id: str) -> mqtt.Client:
    """Start MQTT subscriber to capture messages for an agent"""
    sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"verifier-{agent_id}")
    
    def on_connect(client, userdata, flags, rc, properties=None):
        topic = f"/agentbus/ai/channel/{NS}/{agent_id}/message"
        client.subscribe(topic, qos=1)
    
    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload)
            received_messages[agent_id].append(payload)
            print(f"  [{agent_id}] Received: {payload.get('text', '')[:50]}")
        except:
            pass
    
    sub.on_connect = on_connect
    sub.on_message = on_message
    sub.connect("127.0.0.1", BROKER_PORT)
    sub.loop_start()
    return sub


def create_mcp_client(agent_id: str):
    """Create MCP client for an agent"""
    url = f"{HUB}/sse?client_id={agent_id}&ns={NS}&token=t25-hub-token"
    return sse_client(url)


async def send_message(session: ClientSession, to: str, text: str):
    """Send message via MCP"""
    result = await session.call_tool("send_message", {"to": to, "text": text})
    return result.content[0].text if result.content else ""


async def run_test(test_name: str, test_fn):
    """Run a single test"""
    print(f"\n{'='*60}")
    print(f"Test: {test_name}")
    print('='*60)
    
    try:
        await test_fn()
        print(f"✅ {test_name} PASSED")
        return True
    except Exception as e:
        print(f"❌ {test_name} FAILED: {e}")
        return False


async def main():
    print("🚀 Cross-Agent Test via MCP/SSE")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Hub: {HUB}")
    print(f"Agents: {len(AGENTS)}")
    print()
    
    # Start verifiers for all agents
    print("Starting message verifiers...")
    verifiers = []
    for agent in AGENTS:
        verifier = start_verifier(agent["id"])
        verifiers.append(verifier)
        print(f"  ✅ Verifier for {agent['id']} started")
    
    await asyncio.sleep(1)
    
    results = []
    
    # Test 1: Two-agent communication (A -> B)
    async def test_two_agent_a_to_b():
        received_messages["test-agent-a"].clear()
        received_messages["test-agent-b"].clear()
        
        async with create_mcp_client("test-agent-a") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                # Register agent first
                await session.call_tool("register_agent", {"name": "Test Agent A", "description": "Test", "capabilities": []})
                await send_message(session, f"{NS}/test-agent-b", "Hello from A to B")
        
        await asyncio.sleep(2)
        
        if len(received_messages["test-agent-b"]) == 0:
            raise Exception("Agent B did not receive message")
        
        msg = received_messages["test-agent-b"][0]
        if "test-agent-a" not in msg.get("from", ""):
            raise Exception(f"Wrong sender: {msg.get('from')}")
    
    results.append(await run_test("Two-Agent: A -> B", test_two_agent_a_to_b))
    
    # Test 2: Two-agent communication (B -> A)
    async def test_two_agent_b_to_a():
        received_messages["test-agent-a"].clear()
        received_messages["test-agent-b"].clear()
        
        async with create_mcp_client("test-agent-b") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.call_tool("register_agent", {"name": "Test Agent B", "description": "Test", "capabilities": []})
                await send_message(session, f"{NS}/test-agent-a", "Hello from B to A")
        
        await asyncio.sleep(2)
        
        if len(received_messages["test-agent-a"]) == 0:
            raise Exception("Agent A did not receive message")
    
    results.append(await run_test("Two-Agent: B -> A", test_two_agent_b_to_a))
    
    # Test 3: Three-agent broadcast (A -> B, C)
    async def test_three_agent_broadcast():
        received_messages["test-agent-a"].clear()
        received_messages["test-agent-b"].clear()
        received_messages["test-agent-c"].clear()
        
        async with create_mcp_client("test-agent-a") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await send_message(session, f"{NS}/test-agent-b,{NS}/test-agent-c", "Broadcast from A")
        
        await asyncio.sleep(2)
        
        if len(received_messages["test-agent-b"]) == 0:
            raise Exception("Agent B did not receive broadcast")
        if len(received_messages["test-agent-c"]) == 0:
            raise Exception("Agent C did not receive broadcast")
    
    results.append(await run_test("Three-Agent: A -> B, C", test_three_agent_broadcast))
    
    # Test 4: Multi-agent conversation (A -> B, B -> C, C -> A)
    async def test_multi_agent_conversation():
        received_messages["test-agent-a"].clear()
        received_messages["test-agent-b"].clear()
        received_messages["test-agent-c"].clear()
        
        async with create_mcp_client("test-agent-a") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await send_message(session, f"{NS}/test-agent-b", "A to B")
        
        await asyncio.sleep(1)
        
        async with create_mcp_client("test-agent-b") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.call_tool("register_agent", {"name": "Test Agent B", "description": "Test", "capabilities": []})
                await send_message(session, f"{NS}/test-agent-c", "B to C")
        
        await asyncio.sleep(1)
        
        async with create_mcp_client("test-agent-c") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await session.call_tool("register_agent", {"name": "Test Agent C", "description": "Test", "capabilities": []})
                await send_message(session, f"{NS}/test-agent-a", "C to A")
        
        await asyncio.sleep(2)
        
        if len(received_messages["test-agent-b"]) == 0:
            raise Exception("B did not receive from A")
        if len(received_messages["test-agent-c"]) == 0:
            raise Exception("C did not receive from B")
        if len(received_messages["test-agent-a"]) == 0:
            raise Exception("A did not receive from C")
    
    results.append(await run_test("Multi-Agent Conversation", test_multi_agent_conversation))
    
    # Test 5: Four-agent broadcast (A -> B, C, D)
    async def test_four_agent_broadcast():
        received_messages["test-agent-a"].clear()
        received_messages["test-agent-b"].clear()
        received_messages["test-agent-c"].clear()
        received_messages["test-agent-d"].clear()
        
        async with create_mcp_client("test-agent-a") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                targets = ",".join([f"{NS}/test-agent-b", f"{NS}/test-agent-c", f"{NS}/test-agent-d"])
                await send_message(session, targets, "Four-agent broadcast")
        
        await asyncio.sleep(2)
        
        for agent_id in ["test-agent-b", "test-agent-c", "test-agent-d"]:
            if len(received_messages[agent_id]) == 0:
                raise Exception(f"{agent_id} did not receive broadcast")
    
    results.append(await run_test("Four-Agent: A -> B, C, D", test_four_agent_broadcast))
    
    # Test 6: Offline status detection
    async def test_offline_detection():
        # Stop verifier for agent-d to simulate offline
        verifiers[3].loop_stop()
        verifiers[3].disconnect()
        
        await asyncio.sleep(2)
        
        # Try to send to agent-d
        async with create_mcp_client("test-agent-a") as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await send_message(session, f"{NS}/test-agent-d", "Message to offline agent")
                
                # Check if response indicates offline
                if "offline" in result.lower() or "离线" in result:
                    print("  ✓ Offline status correctly detected")
                    return
                
                raise Exception("Offline status not properly reported")
    
    results.append(await run_test("Offline Status Detection", test_offline_detection))
    
    # Summary
    print("\n" + "="*60)
    print("📊 Test Results Summary")
    print("="*60)
    
    passed = sum(results)
    total = len(results)
    
    print(f"Total: {passed}/{total} passed")
    
    if passed == total:
        print("\n✅ All tests passed!")
    else:
        print(f"\n❌ {total - passed} test(s) failed")
    
    # Cleanup
    print("\nStopping verifiers...")
    for verifier in verifiers:
        try:
            verifier.loop_stop()
            verifier.disconnect()
        except:
            pass
    
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
