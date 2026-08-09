/**
 * TASK-06: sessions.json 注册表 —— 原子写（tmp+rename）+ 损坏恢复（零数据损坏）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyRegistry,
  knownSenders,
  loadRegistry,
  saveRegistry,
  touchSession,
  type RegistryData,
} from "../src/daemon/registry.js";

let dir: string;
let regPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-reg-"));
  regPath = join(dir, "sessions.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadRegistry", () => {
  it("文件不存在返回空注册表", () => {
    const reg = loadRegistry(regPath);
    expect(reg.version).toBe(1);
    expect(reg.senders).toEqual({});
  });

  it("正常文件可读取", () => {
    writeFileSync(regPath, JSON.stringify({ version: 1, senders: { "be-svc": { kilo: { sessionId: "s1", tool: "kilo", createdAt: 1, lastActive: 2 } } } }));
    const reg = loadRegistry(regPath);
    expect(reg.senders["be-svc"]!.kilo!.sessionId).toBe("s1");
  });

  it("损坏文件（kill -9 半写）→ 备份为 .corrupt-* 并返回空注册表（不带病运行）", () => {
    writeFileSync(regPath, '{"version":1,"senders":{truncated');
    const reg = loadRegistry(regPath);
    expect(reg.senders).toEqual({});
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(backups.length).toBe(1);
    // 原始损坏内容被完整保留用于人工恢复
    expect(readFileSync(join(dir, backups[0]!), "utf-8")).toContain("truncated");
  });
});

describe("saveRegistry（原子写）", () => {
  it("写入后内容一致且无残留 tmp 文件", () => {
    const reg = emptyRegistry();
    reg.senders["be-svc"] = { kilo: { sessionId: "s1", tool: "kilo", createdAt: 1, lastActive: 1 } };
    saveRegistry(regPath, reg);
    const parsed = JSON.parse(readFileSync(regPath, "utf-8")) as RegistryData;
    expect(parsed.senders["be-svc"]!.kilo!.sessionId).toBe("s1");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("先写 tmp 再 rename —— 目标文件在任意时刻都是完整 JSON 或不存在", () => {
    // 通过连续大量写入验证：每次写入后文件都能被完整解析
    for (let i = 0; i < 20; i++) {
      const reg = emptyRegistry();
      reg.senders[`s${i}`] = { kilo: { sessionId: `id-${i}`, tool: "kilo", createdAt: i, lastActive: i } };
      saveRegistry(regPath, reg);
      expect(() => JSON.parse(readFileSync(regPath, "utf-8"))).not.toThrow();
    }
  });
});

describe("touchSession", () => {
  it("陌生发件人创建会话并返回 isNew=true", () => {
    const reg = emptyRegistry();
    const { entry, isNew } = touchSession(reg, "be-svc", "kilo", () => "sess-1", 1000);
    expect(isNew).toBe(true);
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.createdAt).toBe(1000);
    expect(entry.lastActive).toBe(1000);
  });

  it("已有会话只刷新 lastActive 不换 sessionId", () => {
    const reg = emptyRegistry();
    touchSession(reg, "be-svc", "kilo", () => "sess-1", 1000);
    const { entry, isNew } = touchSession(reg, "be-svc", "kilo", () => "sess-2", 2000);
    expect(isNew).toBe(false);
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.lastActive).toBe(2000);
  });

  it("同一发件人不同工具各自独立会话", () => {
    const reg = emptyRegistry();
    touchSession(reg, "be-svc", "kilo", () => "k-1", 1);
    const { entry } = touchSession(reg, "be-svc", "qoder", () => "q-1", 1);
    expect(entry.sessionId).toBe("q-1");
  });
});

describe("knownSenders", () => {
  it("返回注册表中所有发件人集合", () => {
    const reg = emptyRegistry();
    touchSession(reg, "a", "kilo", () => "1", 1);
    touchSession(reg, "b", "kilo", () => "2", 1);
    expect(knownSenders(reg)).toEqual(new Set(["a", "b"]));
  });

  it("损坏恢复后的空注册表返回空集合", () => {
    expect(knownSenders(loadRegistry(regPath))).toEqual(new Set());
    expect(existsSync(regPath)).toBe(false); // 读取不产生副作用文件
  });
});
