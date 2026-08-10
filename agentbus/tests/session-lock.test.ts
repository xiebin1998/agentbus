/**
 * TASK-29: 会话级串行锁（并发不串话，PLAN T25 验收）
 *
 * 背景：限速内同源多条消息逐条并发注入，同一会话（hermes -c <名> / claude -r /
 * qoder --session-id）存在并发竞争 → 回合需按到达顺序串行；不同会话保持并行。
 */
import { describe, expect, it } from "vitest";
import { SessionLock } from "../src/daemon/session-lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SessionLock（同键 FIFO 串行，异键并行）", () => {
  it("同键任务按提交顺序串行执行（无重叠）", async () => {
    const lock = new SessionLock();
    const events: string[] = [];
    const mk = (tag: string, ms: number) => async () => {
      events.push(`start:${tag}`);
      await sleep(ms);
      events.push(`end:${tag}`);
      return tag;
    };
    const p1 = lock.run("s1", mk("a", 30));
    const p2 = lock.run("s1", mk("b", 10));
    const p3 = lock.run("s1", mk("c", 1));
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(["a", "b", "c"]);
    // 严格串行：每个 start 前一个是 end
    expect(events).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("异键任务并行执行（互不阻塞）", async () => {
    const lock = new SessionLock();
    const order: string[] = [];
    // s2 任务更短：若串行必先 s1 完成才轮到 s2 → end:s2 反而先到证明并行
    const p1 = lock.run("s1", async () => { await sleep(40); order.push("end:s1"); });
    const p2 = lock.run("s2", async () => { await sleep(5); order.push("end:s2"); });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["end:s2", "end:s1"]);
  });

  it("前序任务抛错不阻塞后续任务，调用方各自拿到成败", async () => {
    const lock = new SessionLock();
    const p1 = lock.run("s1", async () => { throw new Error("回合失败"); });
    const p2 = lock.run("s1", async () => "后继成功");
    await expect(p1).rejects.toThrow("回合失败");
    await expect(p2).resolves.toBe("后继成功");
  });
});
