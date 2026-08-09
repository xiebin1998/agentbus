/**
 * TASK-06: 大小触发的日志轮转（daemon.log → .1 → .2 …，保留 keep 份）
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

export interface RotatingLoggerOptions {
  /** 触发轮转的字节上限 */
  maxBytes: number;
  /** 保留的历史份数（不含当前文件） */
  keep: number;
}

export class RotatingLogger {
  constructor(
    private filePath: string,
    private opts: RotatingLoggerOptions,
  ) {}

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string): void {
    this.write("ERROR", msg);
  }

  private write(level: string, msg: string): void {
    this.rotateIfNeeded();
    appendFileSync(this.filePath, `${new Date().toISOString()} [${level}] ${msg}\n`, "utf-8");
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    if (statSync(this.filePath).size < this.opts.maxBytes) return;
    // .N → .N+1（超过 keep 的最旧份删除），当前 → .1
    const oldest = `${this.filePath}.${this.opts.keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.opts.keep - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      if (existsSync(src)) renameSync(src, `${this.filePath}.${i + 1}`);
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}
