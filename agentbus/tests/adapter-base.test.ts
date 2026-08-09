/**
 * TASK-07: Adapter 执行框架 base.ts —— spawn 收集 stdout/stderr + 超时 kill
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/adapters/base.js";

describe("runCommand", () => {
  it("捕获 stdout 与退出码", async () => {
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stdout.write('hello')"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("捕获 stderr 与非零退出码（不抛异常）", async () => {
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "process.stderr.write('oops'); process.exit(3)"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops");
  });

  it("超时 kill 进程并标记 timedOut", async () => {
    const started = Date.now();
    const result = await runCommand({
      cmd: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("命令不存在返回 spawn 错误（不抛异常）", async () => {
    const result = await runCommand({
      cmd: "no-such-binary-agentbus-test",
      args: [],
      timeoutMs: 5000,
    });
    expect(result.error).toMatch(/spawn|ENOENT|找不到/i);
  });

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
  });
});
