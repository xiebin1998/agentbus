/**
 * TASK-06: 日志轮转（大小触发，保留 N 份）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RotatingLogger } from "../src/daemon/logger.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-log-"));
  logPath = join(dir, "daemon.log");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RotatingLogger", () => {
  it("写入带时间戳与级别的行", () => {
    const logger = new RotatingLogger(logPath, { maxBytes: 10_000, keep: 3 });
    logger.info("hello world");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] hello world\n$/);
  });

  it("超过 maxBytes 触发轮转：当前文件重命名为 .1，新行写入新文件", () => {
    // 预置一个接近上限的日志文件
    writeFileSync(logPath, "x".repeat(150) + "\n");
    const logger = new RotatingLogger(logPath, { maxBytes: 100, keep: 3 });
    logger.info("after rotate");
    expect(readFileSync(logPath + ".1", "utf-8")).toContain("x".repeat(150));
    expect(readFileSync(logPath, "utf-8")).toContain("after rotate");
  });

  it("轮转链按序后移（.1→.2），超过 keep 的最旧份被删除", () => {
    writeFileSync(logPath, "current\n");
    writeFileSync(logPath + ".1", "one\n");
    writeFileSync(logPath + ".2", "two\n");
    const logger = new RotatingLogger(logPath, { maxBytes: 1, keep: 2 });
    logger.warn("trigger");
    expect(readFileSync(logPath + ".2", "utf-8")).toBe("one\n"); // 原 .1 后移
    expect(existsSync(logPath + ".3")).toBe(false);               // 原 .2 被逐出（keep=2）
  });

  it("轮转次数多时文件总数不超过 keep + 1", () => {
    const logger = new RotatingLogger(logPath, { maxBytes: 10, keep: 3 });
    for (let i = 0; i < 10; i++) logger.info(`line-${i}-padding-padding`);
    const files = readdirSync(dir).filter((f) => f.startsWith("daemon.log"));
    expect(files.length).toBeLessThanOrEqual(4); // 当前 + .1/.2/.3
  });
});
