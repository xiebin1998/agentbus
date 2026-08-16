#!/usr/bin/env node
/**
 * Cross-Agent Test using Hub API
 * Tests message passing between multiple agents via HTTP API
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../agentbus/dist/daemon/daemon.js";

const BROKER_PORT = 18830;
const NS = "iot";
const HUB_URL = "http://localhost:8000";

// Test agents
const agents = [
  { id: "agent-a", name: "Agent A (Mock Claude)" },
  { id: "agent-b", name: "Agent B (Mock Codex)" },
  { id: "agent-c", name: "Agent C (Mock Qoder)" },
  { id: "agent-d", name: "Agent D (Mock Opencode)" },
];

const daemons = [];
const receivedMessages = new Map();

function createMockDaemon(agent) {
  const received = [];
  receivedMessages.set(agent.id, received);
  
  return new Daemon({
    config: {
      client_id: agent.id,
      ns: NS,
      broker: { host: "127.0.0.1", port: BROKER_PORT },
      default_tool: "mock",
      allowed_senders: [],
      hop_limit: 3,
      rate_limit: 100,
      tools: { mock: {} },
      ack: true,
    },
    workDir: mkdtempSync(join(tmpdir(), `agentbus-${agent.id}-`)),
    inject: async (ctx) => {
      const msg = {
        from: ctx.msg.from,
        text: ctx.msg.text,
        timestamp: new Date().toISOString(),
      };
      received.push(msg);
      console.log(`  [${agent.id}] Received from ${ctx.msg.from}: ${ctx.msg.text}`);
      return { output: `[${agent.name}] Acknowledged: ${ctx.msg.text}` };
    },
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMessageViaHub(fromId, toId, text) {
  const target = toId.includes(",") 
    ? toId.split(",").map(id => `${NS}/${id}`).join(",")
    : `${NS}/${toId}`;
  
  console.log(`  Sending: ${fromId} -> ${toId}: "${text}"`);
  
  const response = await fetch(`${HUB_URL}/api/mcp/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: fromId,
      ns: NS,
      tool: "send_message",
      arguments: {
        to: target,
        text: text,
      },
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Hub API error: ${response.status} - ${error}`);
  }
  
  return await response.json();
}

async function listAgents() {
  const response = await fetch(`${HUB_URL}/api/console/agents?ns=${NS}`);
  if (!response.ok) {
    throw new Error(`Failed to list agents: ${response.status}`);
  }
  return await response.json();
}

async function runTest(testName, testFn) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Test: ${testName}`);
  console.log("=".repeat(60));
  
  try {
    await testFn();
    console.log(`✅ ${testName} PASSED`);
    return true;
  } catch (error) {
    console.log(`❌ ${testName} FAILED: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log("🚀 Cross-Agent Test via Hub API");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Hub: ${HUB_URL}`);
  console.log(`Agents: ${agents.length}`);
  console.log("");
  
  // Check hub health
  try {
    const health = await fetch(`${HUB_URL}/health`);
    const status = await health.json();
    console.log(`Hub status: ${status.status}`);
    console.log(`Online agents: ${Object.keys(status.online_agents || {}).length}`);
  } catch (error) {
    console.error(`❌ Hub not available: ${error.message}`);
    process.exit(1);
  }
  
  // Start all daemons
  console.log("\nStarting daemons...");
  for (const agent of agents) {
    const daemon = createMockDaemon(agent);
    const result = daemon.start();
    if (!result.started) {
      console.error(`❌ Failed to start ${agent.id}: ${result.reason}`);
      process.exit(1);
    }
    daemons.push(daemon);
    console.log(`  ✅ ${agent.name} started`);
  }
  
  await sleep(3000); // Wait for connections
  
  // List agents
  console.log("\nRegistered agents:");
  try {
    const agentsList = await listAgents();
    for (const agent of agentsList.agents || []) {
      console.log(`  - ${agent.client_id} (${agent.mqtt_connected ? "online" : "offline"})`);
    }
  } catch (error) {
    console.log(`  Warning: Could not list agents: ${error.message}`);
  }
  
  const results = [];
  
  // Test 1: Two-agent communication (A -> B)
  results.push(await runTest("Two-Agent: A -> B", async () => {
    receivedMessages.get("agent-a").length = 0;
    receivedMessages.get("agent-b").length = 0;
    
    await sendMessageViaHub("agent-a", "agent-b", "Hello from A to B");
    await sleep(2000);
    
    const bReceived = receivedMessages.get("agent-b");
    if (bReceived.length === 0) {
      throw new Error("Agent B did not receive message");
    }
    if (!bReceived[0].from.includes("agent-a")) {
      throw new Error(`Wrong sender: ${bReceived[0].from}`);
    }
  }));
  
  // Test 2: Two-agent communication (B -> A)
  results.push(await runTest("Two-Agent: B -> A", async () => {
    receivedMessages.get("agent-a").length = 0;
    receivedMessages.get("agent-b").length = 0;
    
    await sendMessageViaHub("agent-b", "agent-a", "Hello from B to A");
    await sleep(2000);
    
    const aReceived = receivedMessages.get("agent-a");
    if (aReceived.length === 0) {
      throw new Error("Agent A did not receive message");
    }
  }));
  
  // Test 3: Three-agent broadcast (A -> B, C)
  results.push(await runTest("Three-Agent: A -> B, C", async () => {
    receivedMessages.get("agent-a").length = 0;
    receivedMessages.get("agent-b").length = 0;
    receivedMessages.get("agent-c").length = 0;
    
    await sendMessageViaHub("agent-a", "agent-b,agent-c", "Broadcast from A");
    await sleep(2000);
    
    const bReceived = receivedMessages.get("agent-b");
    const cReceived = receivedMessages.get("agent-c");
    
    if (bReceived.length === 0) {
      throw new Error("Agent B did not receive broadcast");
    }
    if (cReceived.length === 0) {
      throw new Error("Agent C did not receive broadcast");
    }
  }));
  
  // Test 4: Multi-agent conversation (A -> B, B -> C, C -> A)
  results.push(await runTest("Multi-Agent Conversation", async () => {
    receivedMessages.get("agent-a").length = 0;
    receivedMessages.get("agent-b").length = 0;
    receivedMessages.get("agent-c").length = 0;
    
    await sendMessageViaHub("agent-a", "agent-b", "A to B");
    await sleep(1000);
    await sendMessageViaHub("agent-b", "agent-c", "B to C");
    await sleep(1000);
    await sendMessageViaHub("agent-c", "agent-a", "C to A");
    await sleep(2000);
    
    if (receivedMessages.get("agent-b").length === 0) {
      throw new Error("B did not receive from A");
    }
    if (receivedMessages.get("agent-c").length === 0) {
      throw new Error("C did not receive from B");
    }
    if (receivedMessages.get("agent-a").length === 0) {
      throw new Error("A did not receive from C");
    }
  }));
  
  // Test 5: Four-agent scenario
  results.push(await runTest("Four-Agent: A -> B, C, D", async () => {
    receivedMessages.get("agent-a").length = 0;
    receivedMessages.get("agent-b").length = 0;
    receivedMessages.get("agent-c").length = 0;
    receivedMessages.get("agent-d").length = 0;
    
    await sendMessageViaHub("agent-a", "agent-b,agent-c,agent-d", "Four-agent broadcast");
    await sleep(2000);
    
    const allReceived = ["agent-b", "agent-c", "agent-d"].every(id => 
      receivedMessages.get(id).length > 0
    );
    
    if (!allReceived) {
      throw new Error("Not all agents received the message");
    }
  }));
  
  // Test 6: Offline status detection
  results.push(await runTest("Offline Status Detection", async () => {
    // Stop agent-d
    const daemonD = daemons.find(d => d.config.client_id === "agent-d");
    daemonD.stop();
    daemons.splice(daemons.indexOf(daemonD), 1);
    
    await sleep(2000);
    
    // Try to send to agent-d (should report offline)
    try {
      const result = await sendMessageViaHub("agent-a", "agent-d", "Message to offline agent");
      
      // Check if response indicates offline status
      if (result.content && result.content[0]) {
        const text = result.content[0].text;
        if (text.includes("offline") || text.includes("离线")) {
          console.log("  ✓ Offline status correctly detected");
          return;
        }
      }
      
      throw new Error("Offline status not properly reported");
    } catch (error) {
      // Expected to fail or report offline
      if (error.message.includes("offline") || error.message.includes("离线")) {
        console.log("  ✓ Offline status correctly detected");
        return;
      }
      throw error;
    }
  }));
  
  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 Test Results Summary");
  console.log("=".repeat(60));
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`Total: ${passed}/${total} passed`);
  
  if (passed === total) {
    console.log("\n✅ All tests passed!");
  } else {
    console.log(`\n❌ ${total - passed} test(s) failed`);
  }
  
  // Cleanup
  console.log("\nStopping daemons...");
  for (const daemon of daemons) {
    daemon.stop();
  }
  
  process.exit(passed === total ? 0 : 1);
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
