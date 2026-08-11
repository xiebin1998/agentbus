/**
 * Plan 3 问题 1：会话标题用 agents.json 快照里的名称（如"心语大师"），不再用裸 client_id。
 * lookupAgentName 是纯读取函数：文件缺失/损坏/无此身份/名称为空 → 一律 null（调用方回退 client_id）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupAgentName } from "../src/daemon/snapshot.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-snap-name-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSnapshot(agents: unknown[]): void {
  writeFileSync(join(dir, "agents.json"),
    JSON.stringify({ generated_at: "2026-08-11T00:00:00Z", agents }), "utf-8");
}

describe("lookupAgentName（agents.json 名称解析）", () => {
  it("命中 client_id 时返回档案名称", () => {
    writeSnapshot([
      { client_id: "ag-8a829218", name: "心语大师", online: true },
      { client_id: "ag-f10f3608", name: "云帆同学", online: true },
    ]);
    expect(lookupAgentName(dir, "ag-8a829218")).toBe("心语大师");
    expect(lookupAgentName(dir, "ag-f10f3608")).toBe("云帆同学");
  });

  it("未命中 client_id 返回 null（回退 client_id 显示）", () => {
    writeSnapshot([{ client_id: "ag-1", name: "甲" }]);
    expect(lookupAgentName(dir, "ghost")).toBeNull();
  });

  it("快照文件不存在返回 null", () => {
    expect(lookupAgentName(dir, "ag-1")).toBeNull();
  });

  it("快照 JSON 损坏返回 null（快照是缓存，不能因解析失败影响注入）", () => {
    writeFileSync(join(dir, "agents.json"), "{ 半截 JSON", "utf-8");
    expect(lookupAgentName(dir, "ag-1")).toBeNull();
  });

  it("名称为空串/非字符串视为未命名，返回 null", () => {
    writeSnapshot([
      { client_id: "ag-1", name: "" },
      { client_id: "ag-2", name: 123 },
    ]);
    expect(lookupAgentName(dir, "ag-1")).toBeNull();
    expect(lookupAgentName(dir, "ag-2")).toBeNull();
  });
});
