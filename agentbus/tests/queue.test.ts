/**
 * TASK-06: 每工具 FIFO 有界队列（限速溢出时逐出最旧）
 */
import { describe, expect, it } from "vitest";
import { QueueManager, ToolQueue } from "../src/daemon/queue.js";

describe("ToolQueue", () => {
  it("FIFO 顺序 pop", () => {
    const q = new ToolQueue<string>(10);
    q.push("a");
    q.push("b");
    expect(q.pop()).toBe("a");
    expect(q.pop()).toBe("b");
    expect(q.pop()).toBeUndefined();
  });

  it("容量满时 push 逐出最旧并返回被逐出项", () => {
    const q = new ToolQueue<number>(2);
    expect(q.push(1).evicted).toBeNull();
    expect(q.push(2).evicted).toBeNull();
    expect(q.push(3).evicted).toBe(1);
    expect(q.peek()).toBe(2);
    expect(q.size).toBe(2);
  });

  it("peek 不移除元素", () => {
    const q = new ToolQueue<string>(5);
    q.push("x");
    expect(q.peek()).toBe("x");
    expect(q.size).toBe(1);
  });
});

describe("QueueManager（每工具一条队列）", () => {
  it("不同工具的队列互不影响", () => {
    const mgr = new QueueManager<string>(2);
    mgr.push("kilo", "k1");
    mgr.push("qoder", "q1");
    expect(mgr.pop("kilo")).toBe("k1");
    expect(mgr.pop("qoder")).toBe("q1");
  });

  it("队列按容量独立逐出", () => {
    const mgr = new QueueManager<string>(1);
    expect(mgr.push("kilo", "a").evicted).toBeNull();
    expect(mgr.push("kilo", "b").evicted).toBe("a");
    expect(mgr.depth("kilo")).toBe(1);
  });

  it("pop 空队列返回 undefined 且不产生新队列残留", () => {
    const mgr = new QueueManager<string>(2);
    expect(mgr.pop("ghost")).toBeUndefined();
    expect(mgr.depth("ghost")).toBe(0);
  });
});
