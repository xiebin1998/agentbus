/**
 * TASK-07: Adapter 执行框架 base.ts —— spawn 收集 stdout/stderr + 超时 kill
 */
import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "../src/adapters/base.js";

describe("resolveSpawnTarget（TASK-27 抽出：长活进程复用 Windows shim 解析）", () => {
  it("非 win32：原样返回无前缀", () => {
    expect(resolveSpawnTarget("/usr/bin/opencode", "linux")).toEqual({ cmd: "/usr/bin/opencode", prefix: [], verbatim: false });
  });

  it("win32 裸名：.cmd shim 经 cmd.exe 套壳（与 runCommand 同源语义）", () => {
    const r = resolveSpawnTarget("opencode", "win32");
    expect(r.cmd).toBe("cmd.exe");
    expect(r.prefix.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r.prefix[3]).toMatch(/opencode(\.(cmd|bat|exe|com))?"?$/i);
    expect(r.verbatim).toBe(true);
  });
});

import { runCommand } from "../src/adapters/base.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runCommand", () => {
  // 启动真实子进程的用例统一宽超时：vitest 默认 5s，全量并发负载下进程启动慢会误杀
  const PROC_TIMEOUT = 20_000;

  it("捕获 stdout 与退出码", async () => {
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stdout.write('hello')"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  }, PROC_TIMEOUT);

  it("捕获 stderr 与非零退出码（不抛异常）", async () => {
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stderr.write('oops'); process.exit(3)"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops");
  }, PROC_TIMEOUT);

  it("超时 kill 进程并标记 timedOut", async () => {
    const started = Date.now();
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, PROC_TIMEOUT);

  it("命令不存在返回 spawn 错误（不抛异常）", async () => {
    const result = await runCommand({
      cmd: "no-such-binary-agentbus-test",
      args: [],
      timeoutMs: 5000,
    });
    expect(result.error).toMatch(/spawn|ENOENT|找不到/i);
  }, PROC_TIMEOUT);

  it("cwd 参数生效", async () => {
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: process.env.TEMP ?? process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    // Windows 短路径/大小写差异：统一小写比较
    expect(result.stdout.toLowerCase()).toBe((process.env.TEMP ?? process.cwd()).toLowerCase());
  }, PROC_TIMEOUT);

  it("子进程 stdin 立即关闭（TASK-16 实测：codex 等 stdin EOF 会阻塞回合）", async () => {
    // 脚本等 stdin EOF 后才输出；若 stdin 未关闭将超时
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF-REACHED'))"],
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("EOF-REACHED");
  }, PROC_TIMEOUT);

  it.skipIf(process.platform !== "win32")("Windows：.cmd shim 可直接作为 cmd 运行（TASK-16 实测：codex/qodercli 均为 .cmd）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-cmd-"));
    const shim = join(dir, "shim-test.cmd");
    writeFileSync(shim, "@echo hello-from-cmd %1\r\n", "utf-8");
    try {
      const result = await runCommand({ cmd: shim, args: ["argA"], timeoutMs: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello-from-cmd argA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROC_TIMEOUT);

  it.skipIf(process.platform !== "win32")("Windows：无扩展名命令经 PATHEXT 解析（spawn 裸名会 ENOENT）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-cmd2-"));
    const shim = join(dir, "shimbare.cmd");
    writeFileSync(shim, "@echo bare-ok\r\n", "utf-8");
    try {
      const result = await runCommand({
        cmd: "shimbare",
        args: [],
        env: { PATH: `${dir};${process.env.PATH ?? ""}` },
        timeoutMs: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe("bare-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROC_TIMEOUT);

  it.skipIf(process.platform !== "win32")("Windows：超时杀整棵进程树（cmd.exe 孙进程持管道实测：单杀 wrapper 会挂死）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-tree-"));
    const hb = join(dir, "hb.txt");
    // .cmd 套壳再起心跳孙进程：每 200ms 追加写文件，存活即可观测（路径经环境变量传，避免引号嵌套）
    const shim = join(dir, "tree.cmd");
    const script = "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.env.HB,'x'),200);setTimeout(()=>{},60000)";
    writeFileSync(shim, `@set "HB=${hb}" && @node -e "${script}"\r\n`, "utf-8");
    try {
      const result = await runCommand({ cmd: shim, args: [], timeoutMs: 1500 });
      expect(result.timedOut).toBe(true);
      // 孙进程被杀净：心跳停止增长
      await new Promise((r) => setTimeout(r, 1200));
      const size1 = existsSync(hb) ? statSync(hb).size : 0;
      await new Promise((r) => setTimeout(r, 1000));
      const size2 = existsSync(hb) ? statSync(hb).size : 0;
      expect(size2).toBe(size1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROC_TIMEOUT);

  it.skipIf(process.platform !== "win32")("Windows：where 同名命中无扩展名 sh 脚本与 .cmd 时优先可执行扩展（npm 全局实测）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-cmd3-"));
    writeFileSync(join(dir, "shimboth"), "#!/bin/sh\necho wrong\n", "utf-8");
    writeFileSync(join(dir, "shimboth.cmd"), "@echo right-cmd\r\n", "utf-8");
    try {
      const result = await runCommand({
        cmd: "shimboth",
        args: [],
        env: { PATH: `${dir};${process.env.PATH ?? ""}` },
        timeoutMs: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe("right-cmd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROC_TIMEOUT);

  it.skipIf(process.platform !== "win32")("Windows：.cmd 参数含 cmd 特殊字符不被分割（TASK-22 实测：sse_url 中 & 被当命令分隔符）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-amp-"));
    const shim = join(dir, "amp-shim.cmd");
    writeFileSync(shim, "@echo %*\r\n", "utf-8");
    try {
      const url = "http://localhost:8000/sse?client_id=accept&ns=default";
      const result = await runCommand({ cmd: shim, args: ["mcp", "add", "agentbus", "--url", url], timeoutMs: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`mcp add agentbus --url "${url}"`);
      expect(result.stderr.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROC_TIMEOUT);
});
