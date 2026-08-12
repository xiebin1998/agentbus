/**
 * TASK-18: Hermes 适配器（远端 Linux Agent，架构 5.5/11.6）
 *
 * 契约要点（架构 11.6 用户提供参数面）：
 * - `-z <prompt>` oneshot：只输出最终结果（stdout 即回合输出），自动绕过审批
 * - `-c <名>` 按名建/续会话（会话名 = 推送来源 client_id）；建/续同一命令形态（按名幂等）
 *   ⚠️ `-c` 对不存在的会话名是新建还是报错待远端实测；报错则回退 `--resume <id>`（架构 5.5）
 * - 无只读权限档（--safe-mode 仅禁自定义扩展，非只读）→ 恒只读，仅信封约束（架构 4.7）
 * - 配 remote（架构 4.4 tools.hermes.remote）时经 SSH 注入远端：
 *   `ssh -o BatchMode=yes [-i key] [user@]host "cd <workspace> && hermes -z ... -c ..."`
 */
import { runCommand, type AdapterTurn, type RunnerResult, type SpawnSpec } from "./base.js";

export interface HermesRemoteConfig {
  host: string;
  user?: string;
  /** SSH 私钥路径（-i；缺省走 ssh 默认密钥/agent） */
  sshKey?: string;
  /** SSH 端口（缺省 22） */
  port?: number;
}

export interface HermesAdapterConfig {
  /** CLI 二进制名/路径（默认 hermes） */
  binary?: string;
  /** 会话工作目录：本机直连为 spawn cwd；remote 为远端 cd 目标 */
  workspace: string;
  /** 单回合超时 */
  timeoutMs?: number;
  /** SSH 段：配置后经 ssh 注入远端（架构 4.4） */
  remote?: HermesRemoteConfig;
}

/** shell 单引号转义（' → '\''），用于远端命令串拼接，防命令注入 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class HermesAdapter {
  private binary: string;
  private timeoutMs: number;

  constructor(
    private cfg: HermesAdapterConfig,
    private run: (spec: SpawnSpec) => Promise<RunnerResult> = runCommand,
  ) {
    this.binary = cfg.binary ?? "hermes";
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
  }

  /** 回合参数：-z oneshot + -c 按名续接；建/续同一形态（按名幂等，同 qoder 族语义） */
  turnArgs(text: string, sessionName: string): string[] {
    return ["-z", text, "-c", sessionName];
  }

  /** hermes 无只读权限档：只读仅靠信封约束；-z 已自动免确认 */
  createSessionArgs(text: string, sessionName: string): string[] {
    return this.turnArgs(text, sessionName);
  }

  injectArgs(text: string, sessionName: string): string[] {
    return this.turnArgs(text, sessionName);
  }

  /** 建会话并注入首条消息；sessionId 语义 = 会话名（按名续接） */
  async createSession(text: string, sessionName: string): Promise<AdapterTurn> {
    return this.runTurn(this.createSessionArgs(text, sessionName), sessionName);
  }

  /** 按名续接注入（与 create 同命令形态） */
  async inject(text: string, sessionName: string): Promise<AdapterTurn> {
    return this.runTurn(this.injectArgs(text, sessionName), sessionName);
  }

  private async runTurn(args: string[], sessionName: string): Promise<AdapterTurn> {
    const spec = this.cfg.remote ? this.remoteSpec(args) : this.localSpec(args);
    const result = await this.run(spec);
    const output = this.extractText(result.stdout);
    let error = result.error;
    if (result.timedOut) {
      error = `hermes 回合超时（${this.timeoutMs}ms）`;
    } else if (result.exitCode !== 0 && !error) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      error = `hermes 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}`;
    }
    return { sessionId: sessionName, output, exitCode: result.exitCode, timedOut: result.timedOut, error };
  }

  private localSpec(args: string[]): SpawnSpec {
    return { cmd: this.binary, args, cwd: this.cfg.workspace, timeoutMs: this.timeoutMs };
  }

  /** remote 形态：ssh 单命令串注入（BatchMode 禁交互提示；消息经 shellQuote 防注入）
   * ConnectTimeout 使远端不可达时快速失败，而非挂到回合超时（真机冒烟实测） */
  private remoteSpec(args: string[]): SpawnSpec {
    const remote = this.cfg.remote!;
    const sshArgs: string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
    if (remote.port) sshArgs.push("-p", String(remote.port));
    if (remote.sshKey) sshArgs.push("-i", remote.sshKey);
    sshArgs.push(remote.user ? `${remote.user}@${remote.host}` : remote.host);
    const [zFlag, text, cFlag, name] = args;
    const remoteCmd = `cd ${shellQuote(this.cfg.workspace)} && ${this.binary} ${zFlag} ${shellQuote(text!)} ${cFlag} ${shellQuote(name!)}`;
    sshArgs.push(remoteCmd);
    return { cmd: "ssh", args: sshArgs, timeoutMs: this.timeoutMs };
  }

  /** -z oneshot 的 stdout 即最终结果（架构 4.6 表）：裸文本 trim */
  extractText(stdout: string): string {
    return stdout.trim();
  }
}
