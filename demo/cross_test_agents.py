#!/usr/bin/env python
"""
AgentBus 交叉测试 - 多 Agent 组合场景
模拟 opencode/codex/claude/qoder 之间的通信
覆盖所有 2-Agent 组合 + 3-Agent + 4-Agent 场景
"""
import asyncio
import json
import sys
from datetime import datetime, timezone
from itertools import combinations

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, r"D:\workSpase\Python\agentbus")
import server

NS = "demo"

class AgentNode:
    """模拟一个 Agent 节点"""
    def __init__(self, name: str, ns: str = NS):
        self.name = name
        self.ns = ns
        self.key = f"{ns}/{name}"
        self.sent_count = 0
        self.received_count = 0
        
    def register(self):
        """注册并上线"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        srv = server.create_mcp_server(self.name, self.ns)
        server._sessions[self.key].mcp_session = object()
        server._sessions[self.key].info.name = self.name
        server._sessions[self.key].info.registered = True
        server._shared_ready.set()
        
        now = datetime.now(timezone.utc).isoformat()
        server._presence_store.update(self.key, "online", now, reason="connected")
        server._metrics_store.update(self.key, {"injected_ok": 1}, now)
        
    async def send(self, to, text: str) -> dict:
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
        self.sent_count += 1
        status = response.get("status", "error")
        targets = to if isinstance(to, list) else [to]
        print(f"    {self.name} -> {', '.join(targets)}: [{status}] {text[:40]}")
        return response
        
    def go_offline(self):
        """下线"""
        server._presence_store.remove(self.key)
        
    @staticmethod
    def cleanup():
        """清理所有状态"""
        keys_to_remove = [k for k in server._sessions.keys() if k.startswith(f"{NS}/")]
        for key in keys_to_remove:
            server._presence_store.remove(key)
            server._metrics_store.remove(key)
            server._sessions.pop(key, None)
            server._agent_info.pop(key, None)


def setup_mock_mqtt():
    """设置模拟 MQTT"""
    from unittest.mock import MagicMock
    from types import SimpleNamespace
    
    mock_client = MagicMock()
    mock_client.is_connected.return_value = True
    mock_client.publish.return_value = SimpleNamespace(rc=0)
    mock_client.subscribe.return_value = (0, 1)
    
    server._shared_client = mock_client
    server._shared_ready.set()


async def test_pair(agent_a: AgentNode, agent_b: AgentNode) -> bool:
    """测试一对 Agent 双向通信"""
    r1 = await agent_a.send(agent_b.name, f"Hello from {agent_a.name} to {agent_b.name}")
    if r1.get("status") != "sent":
        return False
    r2 = await agent_b.send(agent_a.name, f"Reply from {agent_b.name} to {agent_a.name}")
    return r2.get("status") == "sent"


async def test_all_2_agent_combinations():
    """测试所有 2-Agent 组合"""
    print("\n" + "="*60)
    print("场景 1: 所有 2-Agent 组合通信")
    print("="*60)
    
    agents = {
        "opencode": AgentNode("opencode"),
        "codex": AgentNode("codex"),
        "claude": AgentNode("claude"),
        "qoder": AgentNode("qoder"),
    }
    
    for agent in agents.values():
        agent.register()
    
    await asyncio.sleep(0.3)
    
    pairs = list(combinations(agents.keys(), 2))
    passed = 0
    failed = 0
    
    for a_name, b_name in pairs:
        a = agents[a_name]
        b = agents[b_name]
        ok = await test_pair(a, b)
        if ok:
            passed += 1
            print(f"  ✓ {a_name} <-> {b_name}")
        else:
            failed += 1
            print(f"  ✗ {a_name} <-> {b_name}")
    
    AgentNode.cleanup()
    print(f"\n  结果: {passed} 通过, {failed} 失败 (共 {len(pairs)} 对)")
    return failed == 0


async def test_3_agent_scenarios():
    """测试 3-Agent 通信场景"""
    print("\n" + "="*60)
    print("场景 2: 3-Agent 通信组合")
    print("="*60)
    
    agent_names = ["opencode", "codex", "claude", "qoder"]
    trios = list(combinations(agent_names, 3))
    passed = 0
    failed = 0
    
    for trio in trios:
        print(f"\n  --- 组合: {', '.join(trio)} ---")
        agents = [AgentNode(name) for name in trio]
        
        for agent in agents:
            agent.register()
        
        await asyncio.sleep(0.2)
        
        trio_ok = True
        
        # 每个 Agent 发送给其他两个
        for i, sender in enumerate(agents):
            targets = [agents[j].name for j in range(len(agents)) if j != i]
            result = await sender.send(targets, f"Message from {sender.name} to all")
            if result.get("status") != "sent":
                trio_ok = False
        
        # 每个 Agent 单独发送给另一个
        for i, sender in enumerate(agents):
            target = agents[(i + 1) % len(agents)]
            result = await sender.send(target.name, f"Direct from {sender.name} to {target.name}")
            if result.get("status") != "sent":
                trio_ok = False
        
        if trio_ok:
            passed += 1
            print(f"  ✓ 3-Agent 组合 {', '.join(trio)} 通过")
        else:
            failed += 1
            print(f"  ✗ 3-Agent 组合 {', '.join(trio)} 失败")
        
        AgentNode.cleanup()
        await asyncio.sleep(0.1)
    
    print(f"\n  结果: {passed} 通过, {failed} 失败 (共 {len(trios)} 组)")
    return failed == 0


async def test_4_agent_scenario():
    """测试 4-Agent 通信场景"""
    print("\n" + "="*60)
    print("场景 3: 4-Agent 全连接通信")
    print("="*60)
    
    agents = [
        AgentNode("opencode"),
        AgentNode("codex"),
        AgentNode("claude"),
        AgentNode("qoder"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.3)
    
    all_ok = True
    
    # 每个 Agent 广播给其他三个
    print("\n  --- 广播模式 ---")
    for i, sender in enumerate(agents):
        targets = [agents[j].name for j in range(len(agents)) if j != i]
        result = await sender.send(targets, f"Broadcast from {sender.name}")
        if result.get("status") != "sent":
            all_ok = False
    
    # 链式传递: opencode -> codex -> claude -> qoder -> opencode
    print("\n  --- 链式传递 ---")
    chain = [0, 1, 2, 3, 0]
    for i in range(len(chain) - 1):
        sender = agents[chain[i]]
        receiver = agents[chain[i + 1]]
        result = await sender.send(receiver.name, f"Chain: {sender.name} -> {receiver.name}")
        if result.get("status") != "sent":
            all_ok = False
    
    # 全连接: 每个 Agent 发送给所有其他 Agent
    print("\n  --- 全连接模式 ---")
    for i, sender in enumerate(agents):
        for j, receiver in enumerate(agents):
            if i != j:
                result = await sender.send(receiver.name, f"Full: {sender.name} -> {receiver.name}")
                if result.get("status") != "sent":
                    all_ok = False
    
    AgentNode.cleanup()
    
    if all_ok:
        print(f"\n  ✓ 4-Agent 全连接通信通过")
    else:
        print(f"\n  ✗ 4-Agent 全连接通信失败")
    
    return all_ok


async def test_offline_with_real_agents():
    """测试真实 Agent 名称的离线场景"""
    print("\n" + "="*60)
    print("场景 4: Agent 离线检测")
    print("="*60)
    
    agents = [
        AgentNode("opencode"),
        AgentNode("codex"),
        AgentNode("claude"),
        AgentNode("qoder"),
    ]
    
    for agent in agents:
        agent.register()
    
    await asyncio.sleep(0.3)
    
    all_ok = True
    
    # claude 离线
    agents[2].go_offline()
    print(f"\n  claude 已离线")
    
    # opencode 尝试发给 claude -> 应该被拒绝
    result = await agents[0].send("claude", "Are you there?")
    if "offline_targets" in result:
        print(f"  ✓ 离线目标 claude 被正确拒绝")
    else:
        print(f"  ✗ 离线目标未被拒绝")
        all_ok = False
    
    # opencode 发给 codex -> 应该成功
    result = await agents[0].send("codex", "Hello codex")
    if result.get("status") == "sent":
        print(f"  ✓ 在线目标 codex 正常接收")
    else:
        print(f"  ✗ 在线目标发送失败")
        all_ok = False
    
    # opencode 发给 codex + claude -> 应该整体拒发
    result = await agents[0].send(["codex", "claude"], "Mixed targets")
    if "offline_targets" in result:
        print(f"  ✓ 混合目标整体拒发")
    else:
        print(f"  ✗ 混合目标未正确拒发")
        all_ok = False
    
    # qoder 也离线
    agents[3].go_offline()
    print(f"\n  qoder 也已离线")
    
    # codex 尝试发给 qoder -> 应该被拒绝
    result = await agents[1].send("qoder", "Hello qoder?")
    if "offline_targets" in result:
        print(f"  ✓ 离线目标 qoder 被正确拒绝")
    else:
        print(f"  ✗ 离线目标 qoder 未被拒绝")
        all_ok = False
    
    # codex 发给 opencode -> 应该成功
    result = await agents[1].send("opencode", "Hello opencode")
    if result.get("status") == "sent":
        print(f"  ✓ 在线目标 opencode 正常接收")
    else:
        print(f"  ✗ 在线目标发送失败")
        all_ok = False
    
    AgentNode.cleanup()
    
    if all_ok:
        print(f"\n  ✓ 离线检测场景通过")
    else:
        print(f"\n  ✗ 离线检测场景失败")
    
    return all_ok


async def main():
    """主测试函数"""
    print("="*60)
    print("AgentBus 交叉测试报告")
    print(f"测试时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"命名空间: {NS}")
    print(f"Agent 类型: opencode, codex, claude, qoder")
    print("="*60)
    
    # 清空状态
    server._sessions.clear()
    server._agent_info.clear()
    server._presence_store._data.clear()
    server._metrics_store._data.clear()
    
    setup_mock_mqtt()
    
    results = {}
    
    try:
        results["2-Agent 组合"] = await test_all_2_agent_combinations()
        results["3-Agent 组合"] = await test_3_agent_scenarios()
        results["4-Agent 全连接"] = await test_4_agent_scenario()
        results["离线检测"] = await test_offline_with_real_agents()
        
    except Exception as e:
        print(f"\n✗ 测试异常: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    # 汇总报告
    print("\n" + "="*60)
    print("测试汇总")
    print("="*60)
    
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    failed = total - passed
    
    for name, ok in results.items():
        status = "✓ 通过" if ok else "✗ 失败"
        print(f"  {status}  {name}")
    
    print(f"\n  总计: {passed}/{total} 场景通过")
    
    if failed == 0:
        print("\n✓ 所有交叉测试通过！")
    else:
        print(f"\n✗ {failed} 个场景失败")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
