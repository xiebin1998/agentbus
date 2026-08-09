/**
 * TASK-06: 每工具 FIFO 有界队列（限速溢出的缓冲层）
 */

export class ToolQueue<T> {
  private items: T[] = [];

  constructor(private capacity: number) {}

  /** 入队；容量满时逐出最旧并返回 */
  push(item: T): { evicted: T | null } {
    let evicted: T | null = null;
    if (this.items.length >= this.capacity) {
      evicted = this.items.shift() ?? null;
    }
    this.items.push(item);
    return { evicted };
  }

  pop(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }
}

/** 每个工具一条独立队列 */
export class QueueManager<T> {
  private queues = new Map<string, ToolQueue<T>>();

  constructor(private capacity: number) {}

  private get(tool: string): ToolQueue<T> {
    let q = this.queues.get(tool);
    if (!q) {
      q = new ToolQueue<T>(this.capacity);
      this.queues.set(tool, q);
    }
    return q;
  }

  push(tool: string, item: T): { evicted: T | null } {
    return this.get(tool).push(item);
  }

  pop(tool: string): T | undefined {
    return this.queues.get(tool)?.pop();
  }

  depth(tool: string): number {
    return this.queues.get(tool)?.size ?? 0;
  }
}
