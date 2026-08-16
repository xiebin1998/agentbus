#!/usr/bin/env python3
"""
Simple Message Test using existing registered agents
"""
import asyncio
import json
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import paho.mqtt.client as mqtt
from mcp import ClientSession
from mcp.client.sse import sse_client

HUB = "http://127.0.0.1:8000"
BROKER_PORT = 18830
NS = "default"

# Use existing registered agents
SENDER = "ag-b9ae3ad7"
RECEIVER = "ag-3ef581fb"

received_messages = []


def start_verifier():
    """Start MQTT subscriber to capture messages"""
    sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="test-verifier")
    
    def on_connect(client, userdata, flags, rc, properties=None):
        topic = f"/agentbus/ai/channel/{NS}/{RECEIVER}/message"
        print(f"Subscribing to: {topic}")
        client.subscribe(topic, qos=1)
    
    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload)
            received_messages.append(payload)
            print(f"✅ Received message: {payload.get('text', '')[:50]}")
        except Exception as e:
            print(f"Error parsing message: {e}")
    
    sub.on_connect = on_connect
    sub.on_message = on_message
    sub.connect("127.0.0.1", BROKER_PORT)
    sub.loop_start()
    return sub


async def main():
    print("🚀 Simple Message Test")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Sender: {NS}/{SENDER}")
    print(f"Receiver: {NS}/{RECEIVER}")
    print()
    
    # Start verifier
    print("Starting message verifier...")
    verifier = start_verifier()
    await asyncio.sleep(1)
    
    # Connect to hub and send message
    print("\nConnecting to hub...")
    url = f"{HUB}/sse?client_id={SENDER}&ns={NS}&token=t25-hub-token"
    
    try:
        async with sse_client(url) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                print("✅ Connected to hub")
                
                # List available tools
                tools = await session.list_tools()
                print(f"Available tools: {[t.name for t in tools.tools]}")
                
                # Send message
                print(f"\nSending message to {RECEIVER}...")
                result = await session.call_tool(
                    "send_message",
                    {"to": f"{NS}/{RECEIVER}", "text": "Test message from simple test"}
                )
                
                if result.content:
                    print(f"Send result: {result.content[0].text}")
                
                # Wait for message to be received
                print("\nWaiting for message delivery...")
                await asyncio.sleep(3)
                
                if len(received_messages) > 0:
                    print(f"\n✅ SUCCESS: Received {len(received_messages)} message(s)")
                    for i, msg in enumerate(received_messages, 1):
                        print(f"  Message {i}: {msg.get('text', '')}")
                    return 0
                else:
                    print("\n❌ FAILED: No messages received")
                    return 1
    
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    finally:
        verifier.loop_stop()
        verifier.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
