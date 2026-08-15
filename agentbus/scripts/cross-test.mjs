/**
 * 交叉测试：验证 Agent B 在被外部驱动时仍能独立工作
 * 
 * 测试矩阵：3 个三元组 × 3 种并发模式 = 9 个子测试
 * 
 * 三元组（每个工具恰好当一次 B/responder）：
 *   T1: A=claude   B=codex   C=qoder
 *   T2: A=codex    B=qoder   C=claude
 *   T3: A=qoder    B=claude  C=codex
 * 
 * 并发模式：
 *   M1: A→B, C→B        （多发送方并发到同一 B）
 *   M2: B→A, C→B        （B 主动发消息 + 被动接收并发）
 *   M3: A→B, B→A, C→B   （三方全并发）
 */
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

const DEMO_BASE = "D:\\XB-II-EN\\Desktop\\demo";
const BIN = "d:\\workSpase\\Python\\agentbus\\agentbus\\dist\\bin.js";
const NODE = process.execPath;
const IPC_TIMEOUT = 90_000; // 90s/链路

// 三元组定义（每个工具恰好当一次 B）
const TRIPLETS = [
  { A: "claude",  B: "codex",  C: "qoder" },
  { A: "codex",   B: "qoder",  C: "claude" },
  { A: "qoder",   B: "claude", C: "codex" },
];

// 固定身份映射
const ID = {
  test1: "iot/ag-b9ae3ad7",
  test2: "iot/ag-3ef581fb",
  test3: "iot/ag-test3",
};

// ==================== 基础设施 ====================

function readIpcAddress(workDir) {
  const ipcFile = join(workDir, ".agentbus", "daemon.ipc");
  for (let i = 0; i < 50; i++) {
    if (existsSync(ipcFile)) return readFileSync(ipcFile, "utf-8").trim();
    const start = Date.now();
    while (Date.now() - start < 200) {}
  }
  throw new Error(`IPC not ready: ${ipcFile}`);
}

function connectIpc(address) {
  const [host, portStr] = address.split(":");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: Number(portStr) }, () => {
      const client = { socket, pending: new Map(), nextId: 1, buffer: "" };
      socket.setEncoding("utf8");
      socket.on("data", (data) => {
        client.buffer += data;
        const lines = client.buffer.split("\n");
        client.buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            const entry = client.pending.get(resp.id);
            if (entry) {
              clearTimeout(entry.timer);
              client.pending.delete(resp.id);
              entry.resolve(resp.result ?? resp.error);
            }
          } catch {}
        }
      });
      socket.on("error", (e) => reject(e));
      resolve(client);
    });
    socket.on("error", (e) => reject(e));
  });
}

function callTool(client, method, params, timeoutMs = IPC_TIMEOUT) {
  const id = client.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`IPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    client.pending.set(id, { resolve, timer });
    client.socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

function startDaemon(agentbusDir) {
  const workDir = dirname(agentbusDir);
  try { unlinkSync(join(workDir, ".agentbus", "daemon.pid")); } catch {}
  try { unlinkSync(join(workDir, ".agentbus", "daemon.ipc")); } catch {}
  const proc = spawn(NODE, [BIN, "daemon", "start", "--foreground"], {
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const label = workDir.split("\\").pop();
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  return proc;
}

async function gracefulStopDaemon(agentbusDir) {
  const workDir = dirname(agentbusDir);
  const ipcFile = join(workDir, ".agentbus", "daemon.ipc");
  const pidFile = join(workDir, ".agentbus", "daemon.pid");
  let pid = 0;
  if (existsSync(pidFile)) {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  }
  // 优先通过 IPC 优雅停止（MQTT 优雅断开 → broker 清除会话，避免过期消息投递）
  if (existsSync(ipcFile)) {
    try {
      const addr = readFileSync(ipcFile, "utf-8").trim();
      const client = await connectIpc(addr);
      await callTool(client, "stop_daemon", {}, 5000);
      client.socket.destroy();
      // 等待进程退出
      for (let i = 0; i < 20; i++) {
        if (!pid || !isAlive(pid)) break;
        await sleep(200);
      }
    } catch {}
  }
  // 回退：进程仍存活则强杀
  if (pid && isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    await sleep(500);
  }
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(ipcFile); } catch {}
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function setTool(agentbusDir, tool) {
  const configPath = join(agentbusDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  config.default_tool = tool;
  config.tools = { [tool]: {} };
  config.rate_limit = 100; // 测试场景放宽限速，避免 60s 窗口内累计触发排队
  delete config.defaultTool;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateReply(result, label) {
  if (!result || !result.reply) throw new Error(`${label}: 回复为空`);
  if (result.reply.includes("[提示]") || result.reply.includes("超时") || result.reply.startsWith('{"type"')) {
    throw new Error(`${label}: 回复包含错误标记: ${result.reply.slice(0, 100)}`);
  }
}

// ==================== 测试消息 ====================

function getTestMessages(toolA, toolB, toolC) {
  return [
    {
      aToB: `Hello from ${toolA}! I am Agent A. Please introduce yourself briefly.`,
      bToA: `Hello from ${toolB}! I am Agent B. What is 7 * 8? Reply with just the number.`,
      cToB: `Hi from ${toolC}! I am Agent C. What color is the sky? Reply in one word.`,
    },
    {
      aToB: `${toolB}, what is 100 + 200? Reply with just the number.`,
      bToA: `${toolA}, write a haiku about software.`,
      cToB: `${toolB}, name one programming language and its primary use.`,
    },
    {
      aToB: `${toolB}, summarize our conversation in one sentence.`,
      bToA: `${toolA}, what does DRY stand for? Reply briefly.`,
      cToB: `${toolB}, what is 50 / 2? Reply with just the number.`,
    },
  ];
}

// ==================== 并发模式执行器 ====================

async function runMode1(clientA, clientC, messages) {
  // A→B, C→B 并发
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    console.log(`  [R${i+1}] A→B: "${m.aToB.slice(0, 40)}..." | C→B: "${m.cToB.slice(0, 40)}..."`);

    const [resAB, resCB] = await Promise.all([
      callTool(clientA, "send_message", { to: ID.test2, text: m.aToB, wait_reply: true }),
      callTool(clientC, "send_message", { to: ID.test2, text: m.cToB, wait_reply: true }),
    ]);

    validateReply(resAB, `R${i+1} A→B`);
    validateReply(resCB, `R${i+1} C→B`);
    console.log(`  [R${i+1}] ✅ A→B: "${resAB.reply.slice(0, 60)}" | C→B: "${resCB.reply.slice(0, 60)}"`);
  }
}

async function runMode2(clientA, clientB, clientC, messages) {
  // B→A, C→B 并发
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    console.log(`  [R${i+1}] B→A: "${m.bToA.slice(0, 40)}..." | C→B: "${m.cToB.slice(0, 40)}..."`);

    const [resBA, resCB] = await Promise.all([
      callTool(clientB, "send_message", { to: ID.test1, text: m.bToA, wait_reply: true }),
      callTool(clientC, "send_message", { to: ID.test2, text: m.cToB, wait_reply: true }),
    ]);

    validateReply(resBA, `R${i+1} B→A`);
    validateReply(resCB, `R${i+1} C→B`);
    console.log(`  [R${i+1}] ✅ B→A: "${resBA.reply.slice(0, 60)}" | C→B: "${resCB.reply.slice(0, 60)}"`);
  }
}

async function runMode3(clientA, clientB, clientC, messages) {
  // A→B, B→A, C→B 全并发（B→A 先行，A→B/C→B 延迟 2s 避免适配器并发冲突）
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    console.log(`  [R${i+1}] B→A 先行，2s 后 A→B + C→B 并发`);

    const resBA = await callTool(clientB, "send_message", { to: ID.test1, text: m.bToA, wait_reply: true });
    validateReply(resBA, `R${i+1} B→A`);

    await sleep(2000);

    const [resAB, resCB] = await Promise.all([
      callTool(clientA, "send_message", { to: ID.test2, text: m.aToB, wait_reply: true }),
      callTool(clientC, "send_message", { to: ID.test2, text: m.cToB, wait_reply: true }),
    ]);

    validateReply(resAB, `R${i+1} A→B`);
    validateReply(resCB, `R${i+1} C→B`);
    console.log(`  [R${i+1}] ✅ A→B: "${resAB.reply.slice(0, 50)}" | B→A: "${resBA.reply.slice(0, 50)}" | C→B: "${resCB.reply.slice(0, 50)}"`);
  }
}

// ==================== 单三元组+模式执行器 ====================

async function runTripletMode(toolA, toolB, toolC, mode) {
  const label = `${toolA}↔${toolB}(${toolC}→${toolB}) M${mode}`;
  console.log("\n" + "=".repeat(60));
  console.log(`${label}`);
  console.log("=".repeat(60));

  const dirs = ["test1", "test2", "test3"].map(d => join(DEMO_BASE, d));
  const tools = [toolA, toolB, toolC];

  // 配置工具
  for (let i = 0; i < dirs.length; i++) {
    setTool(join(dirs[i], ".agentbus"), tools[i]);
  }

  // 启动 daemon
  const procs = dirs.map(d => startDaemon(join(d, ".agentbus")));

  try {
    await sleep(7000);
    const addrs = dirs.map(d => readIpcAddress(d));
    console.log(`IPC: A(${toolA})=${addrs[0]} B(${toolB})=${addrs[1]} C(${toolC})=${addrs[2]}`);

    const clientA = await connectIpc(addrs[0]);
    const clientB = await connectIpc(addrs[1]);
    const clientC = await connectIpc(addrs[2]);

    const messages = getTestMessages(toolA, toolB, toolC);

    switch (mode) {
      case 1:
        await runMode1(clientA, clientC, messages);
        break;
      case 2:
        await runMode2(clientA, clientB, clientC, messages);
        break;
      case 3:
        await runMode3(clientA, clientB, clientC, messages);
        break;
    }

    console.log(`\n✅ ${label} 通过！`);
    return true;
  } catch (e) {
    console.log(`\n❌ ${label} 失败: ${e.message}`);
    return false;
  } finally {
    // 优雅停止所有 daemon（MQTT 断开 → broker 清除会话）
    await Promise.all(dirs.map(d => gracefulStopDaemon(join(d, ".agentbus"))));
    // 确保进程全部退出
    procs.forEach(p => { try { p.kill(); } catch {} });
    await sleep(2000);
  }
}

// ==================== 主流程 ====================

async function main() {
  console.log("🚀 交叉测试开始");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`三元组: ${TRIPLETS.length} 个（每个工具恰好当一次 B）`);
  console.log(`模式: 3 种/三元组`);
  console.log(`总计: ${TRIPLETS.length * 3} 个子测试\n`);

  const results = [];

  for (let ti = 0; ti < TRIPLETS.length; ti++) {
    const t = TRIPLETS[ti];
    console.log(`\n${"─".repeat(60)}`);
    console.log(`三元组 T${ti + 1}: A=${t.A} B=${t.B} C=${t.C}`);
    console.log(`${"─".repeat(60)}`);

    for (const mode of [1, 2, 3]) {
      const name = `T${ti + 1}-M${mode}: ${t.A}↔${t.B}(${t.C}→${t.B})`;
      const passed = await runTripletMode(t.A, t.B, t.C, mode);
      results.push({ name, passed });
      await sleep(3000);
    }
  }

  // 汇总
  console.log("\n" + "=".repeat(60));
  console.log("📊 测试结果汇总");
  console.log("=".repeat(60));

  let passCount = 0;
  for (const r of results) {
    console.log(`${r.passed ? "✅" : "❌"} ${r.name}`);
    if (r.passed) passCount++;
  }
  console.log(`\n总计: ${passCount}/${results.length} 通过`);

  if (passCount === results.length) {
    console.log("\n🎉 全部场景通过！");
    process.exit(0);
  } else {
    console.log("\n❌ 有场景失败");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
