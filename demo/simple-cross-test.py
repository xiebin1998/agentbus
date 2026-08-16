#!/usr/bin/env python3
"""
Simple cross-agent test using requests
Tests the core functionality without requiring real AI tools
"""
import json
import sys
import time
import requests

# Windows console UTF-8
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HUB_URL = "http://127.0.0.1:8000"
NS = "iot"

def test_offline_detection():
    """Test 1: Verify offline status detection"""
    print("\n" + "="*60)
    print("Test 1: Offline Status Detection")
    print("="*60)
    
    session = requests.Session()
    
    # Login
    resp = session.post(f"{HUB_URL}/api/auth/login",
                       json={"username": "root", "password": "xb5711349"})
    if resp.status_code != 200:
        print(f"❌ Login failed: {resp.status_code}")
        return False
    
    # Try to send message to offline agent
    resp = session.post(f"{HUB_URL}/api/mcp/send_message",
                       json={
                           "ns": NS,
                           "client_id": "test-agent-a",
                           "to": f"{NS}/non-existent-agent",
                           "text": "Test message"
                       })
    result = resp.json()
    
    if "error" in result and "离线" in result.get("error", ""):
        print("✅ Offline status correctly detected")
        print(f"   Response: {json.dumps(result, ensure_ascii=False, indent=2)}")
        return True
    else:
        print(f"❌ Unexpected response: {result}")
        return False

def test_list_agents():
    """Test 2: Verify list_agents shows all registered agents"""
    print("\n" + "="*60)
    print("Test 2: List Agents Visibility")
    print("="*60)
    
    session = requests.Session()
    
    # Login
    resp = session.post(f"{HUB_URL}/api/auth/login",
                       json={"username": "root", "password": "xb5711349"})
    if resp.status_code != 200:
        print(f"❌ Login failed")
        return False
    
    # List agents
    resp = session.get(f"{HUB_URL}/api/console/agents?ns={NS}")
    result = resp.json()
    agents = result.get("agents", [])
    
    print(f"Found {len(agents)} agents in namespace '{NS}':")
    for agent in agents:
        status = "online" if agent.get("mqtt_connected") else "offline"
        print(f"  - {agent['client_id']} ({status})")
    
    if len(agents) > 0:
        print("✅ list_agents returns registered agents")
        return True
    else:
        print("❌ No agents found")
        return False

def test_message_routing():
    """Test 3: Verify message routing with offline targets"""
    print("\n" + "="*60)
    print("Test 3: Message Routing with Offline Targets")
    print("="*60)
    
    session = requests.Session()
    
    # Login
    resp = session.post(f"{HUB_URL}/api/auth/login",
                       json={"username": "root", "password": "xb5711349"})
    if resp.status_code != 200:
        print(f"❌ Login failed")
        return False
    
    # Try to send to multiple targets (some online, some offline)
    resp = session.post(f"{HUB_URL}/api/mcp/send_message",
                       json={
                           "ns": NS,
                           "client_id": "test-agent-a",
                           "to": f"{NS}/test-agent-b,{NS}/offline-agent-1,{NS}/offline-agent-2",
                           "text": "Test broadcast"
                       })
    result = resp.json()
    
    # Should return offline_targets list
    if "offline_targets" in result:
        offline = result["offline_targets"]
        print(f"✅ Correctly identified {len(offline)} offline targets:")
        for target in offline:
            print(f"   - {target}")
        return True
    elif "error" in result:
        print(f"✅ Request rejected (all targets offline): {result['error']}")
        return True
    else:
        print(f"❌ Unexpected response: {result}")
        return False

def main():
    print("🚀 Simple Cross-Agent Test")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Hub: {HUB_URL}")
    
    results = []
    
    # Run tests
    results.append(test_offline_detection())
    results.append(test_list_agents())
    results.append(test_message_routing())
    
    # Summary
    print("\n" + "="*60)
    print("📊 Test Results Summary")
    print("="*60)
    
    passed = sum(results)
    total = len(results)
    
    print(f"Total: {passed}/{total} passed")
    
    if passed == total:
        print("\n✅ All tests passed!")
        return 0
    else:
        print(f"\n❌ {total - passed} test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())
