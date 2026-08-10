/**
 * TASK-29: 会话级串行锁（并发不串话，PLAN T25 验收）
 *
 * 限速内同源多条消息逐条入站时，同一会话的回合必须按到达顺序串行执行
 * （hermes -c <名> / claude -r / qoder --session-id 并发写同一会话会竞争串话）；
 * 不同会话之间保持并行，不互相阻塞。
 */
export class SessionLock {
  /** 每个键的链尾锚点（已吞错，仅供排队；新任务总是链到当前锚点之后） */
  private chains = new Map<string, Promise<unknown>>();

  /** 同键 FIFO 串行执行 fn；异键并行；fn 抛错只影响自身调用方，不阻塞后续任务 */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, () => fn());
    const anchor = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, anchor);
    // 链尾仍是本锚点时清键（避免长生命周期 Map 无界增长）
    void anchor.then(() => {
      if (this.chains.get(key) === anchor) this.chains.delete(key);
    });
    return result;
  }
}
