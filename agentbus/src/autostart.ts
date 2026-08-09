/**
 * TASK-23: 开机自启（架构 4.5 三期）
 *
 * - Windows：用户级 HKCU Run 注册表键（登录时自动执行，非管理员可用；
 *   schtasks ONLOGON 需管理员实测拒绝访问，故不采用）
 * - Linux：systemd 用户单元（ExecStart + Restart=on-failure，enable 挂到 default.target）
 * planAutostart 为纯函数（生成计划不碰磁盘/进程）；install/uninstall/status 经注入点执行，
 * 生产入口回退真实 reg/systemctl 与文件读写。真实重启验收见 TASKS.md（以手动执行 Run 键命令等价触发）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { defaultCliRunner, type CliRunner } from "./detect.js";

export interface AutostartSpec {
  platform: "win32" | "linux";
  projectRoot: string;
  binPath: string;
  configPath: string;
  clientId: string;
  ns: string;
  nodePath: string;
  homeDir?: string;
}

export interface AutostartPlan {
  kind: "hkcu-run" | "systemd";
  /** Windows Run 键值名 / Linux unit 名 */
  taskName: string;
  unitName?: string;
  unitPath?: string;
  unitContent?: string;
  createArgs?: string[];
  deleteArgs?: string[];
  queryArgs?: string[];
}

export interface AutostartDeps extends AutostartSpec {
  runner?: CliRunner;
  writeFile?: (path: string, content: string) => void;
  removeFile?: (path: string) => void;
}

export interface AutostartReport {
  ok: boolean;
  lines: string[];
}

const hash6 = (s: string) => createHash("md5").update(s).digest("hex").slice(0, 6);

const HKCU_RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** 生成平台注册计划（纯函数） */
export function planAutostart(platform: "win32" | "linux", spec: AutostartSpec): AutostartPlan {
  const tag = hash6(spec.projectRoot);
  // 启动命令：node <bin> daemon start -c <config>（绝对路径，自启语境无工作目录）
  const tr = `"${spec.nodePath}" "${spec.binPath}" daemon start -c "${spec.configPath}"`;
  if (platform === "win32") {
    const taskName = `AgentBus-${spec.ns}-${spec.clientId}-${tag}`;
    return {
      kind: "hkcu-run",
      taskName,
      createArgs: ["add", HKCU_RUN, "/v", taskName, "/t", "REG_SZ", "/d", tr, "/f"],
      deleteArgs: ["delete", HKCU_RUN, "/v", taskName, "/f"],
      queryArgs: ["query", HKCU_RUN, "/v", taskName],
    };
  }
  const unitName = `agentbus-${spec.clientId}-${tag}.service`;
  const unitContent = [
    "[Unit]",
    `Description=AgentBus Daemon (${spec.ns}/${spec.clientId})`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${spec.nodePath} ${spec.binPath} daemon start -c ${spec.configPath}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    kind: "systemd",
    taskName: unitName,
    unitName,
    unitPath: posix.join(spec.homeDir ?? "~", ".config", "systemd", "user", unitName),
    unitContent,
  };
}

/** 注册开机自启（幂等：reg add /f 覆盖；systemd 重写 unit + enable） */
export async function runAutostartInstall(deps: AutostartDeps): Promise<AutostartReport> {
  const runner = deps.runner ?? defaultCliRunner;
  const lines: string[] = [];
  const plan = planAutostart(deps.platform, deps);

  if (plan.kind === "hkcu-run") {
    const r = await runner("reg", plan.createArgs!);
    if (r.exitCode !== 0) {
      lines.push(`✗ reg 注册失败（退出码 ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`);
      return { ok: false, lines };
    }
    lines.push(`✓ 已注册开机自启 ${plan.taskName}（HKCU Run，登录时自动拉起 daemon）`);
    lines.push(`  手动触发验证：直接执行注册命令即可（reg query "${HKCU_RUN}" /v ${plan.taskName}）`);
    return { ok: true, lines };
  }

  // systemd 用户单元：写文件 → daemon-reload → enable
  const writeFile = deps.writeFile ?? ((p: string, c: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, "utf-8");
  });
  writeFile(plan.unitPath!, plan.unitContent!);
  lines.push(`✓ 已写入 ${plan.unitPath}`);
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", plan.unitName!]]) {
    const r = await runner("systemctl", args);
    if (r.exitCode !== 0) {
      lines.push(`✗ systemctl ${args.join(" ")} 失败（退出码 ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`);
      return { ok: false, lines };
    }
  }
  lines.push(`✓ 已启用 ${plan.unitName}（systemd --user，登录后自动拉起 daemon）`);
  return { ok: true, lines };
}

/** 移除开机自启 */
export async function runAutostartUninstall(deps: AutostartDeps): Promise<AutostartReport> {
  const runner = deps.runner ?? defaultCliRunner;
  const lines: string[] = [];
  const plan = planAutostart(deps.platform, deps);

  if (plan.kind === "hkcu-run") {
    const r = await runner("reg", plan.deleteArgs!);
    if (r.exitCode !== 0) {
      lines.push(`✗ reg 移除失败（退出码 ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`);
      return { ok: false, lines };
    }
    lines.push(`✓ 已移除开机自启 ${plan.taskName}`);
    return { ok: true, lines };
  }

  const removeFile = deps.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  const r = await runner("systemctl", ["--user", "disable", "--now", plan.unitName!]);
  if (r.exitCode !== 0) {
    lines.push(`⚠ systemctl disable 退出码 ${r.exitCode}（单元可能本就未启用，继续）`);
  }
  removeFile(plan.unitPath!);
  await runner("systemctl", ["--user", "daemon-reload"]);
  lines.push(`✓ 已移除 ${plan.unitName}`);
  return { ok: true, lines };
}

/** 查询是否已注册开机自启 */
export async function runAutostartStatus(deps: AutostartDeps): Promise<{ registered: boolean; detail: string }> {
  const runner = deps.runner ?? defaultCliRunner;
  const plan = planAutostart(deps.platform, deps);
  if (plan.kind === "hkcu-run") {
    const r = await runner("reg", plan.queryArgs!);
    return r.exitCode === 0
      ? { registered: true, detail: `开机自启 ${plan.taskName} 已注册（HKCU Run）` }
      : { registered: false, detail: `开机自启 ${plan.taskName} 未注册` };
  }
  const r = await runner("systemctl", ["--user", "is-enabled", plan.unitName!]);
  return r.exitCode === 0
    ? { registered: true, detail: `${plan.unitName} 已启用` }
    : { registered: false, detail: `${plan.unitName} 未启用` };
}
