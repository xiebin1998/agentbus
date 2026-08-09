/**
 * TASK-23: 开机自启（架构 4.5 三期：Windows HKCU Run / Linux systemd 用户单元）
 *
 * 设计：planAutostart 纯函数生成平台注册计划（HKCU Run reg 参数 / systemd unit 内容），
 * runAutostartInstall/Uninstall/Status 经可注入 runner 执行；真实重启验收以
 * 手动执行 Run 键命令等价触发（见 TASKS.md 待补实测）。
 */
import { describe, expect, it } from "vitest";
import {
  planAutostart,
  runAutostartInstall,
  runAutostartStatus,
  runAutostartUninstall,
} from "../src/autostart.js";

const BASE = {
  platform: "win32" as const,
  projectRoot: "D:\\proj\\demo",
  binPath: "D:\\repo\\agentbus\\dist\\bin.js",
  configPath: "D:\\proj\\demo\\.agentbus\\config.json",
  clientId: "accept",
  ns: "default",
  nodePath: "C:\\node\\node.exe",
};

describe("planAutostart 纯函数", () => {
  it("win32：HKCU Run 计划（reg add 登录时触发 + 键名含 ns/clientId + 命令含 daemon start -c）", () => {
    const plan = planAutostart("win32", BASE);
    expect(plan.kind).toBe("hkcu-run");
    expect(plan.taskName).toMatch(/^AgentBus-default-accept-/);
    const create = plan.createArgs!.join(" ");
    expect(create).toContain("add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(create).toContain("REG_SZ");
    expect(create).toContain("/f");
    expect(create).toContain("daemon start");
    expect(create).toContain(BASE.configPath);
    expect(create).toContain(BASE.nodePath);
    expect(plan.deleteArgs!.join(" ")).toContain("delete HKCU\\Software");
    expect(plan.queryArgs!.join(" ")).toContain("query HKCU\\Software");
  });

  it("win32：任务名按项目目录哈希区分（同 client_id 不同目录不冲突）", () => {
    const a = planAutostart("win32", BASE);
    const b = planAutostart("win32", { ...BASE, projectRoot: "D:\\proj\\other" });
    expect(a.taskName).not.toBe(b.taskName);
  });

  it("linux：systemd 用户单元（ExecStart 含 daemon start -c + 失败自重启）", () => {
    const plan = planAutostart("linux", BASE);
    expect(plan.kind).toBe("systemd");
    expect(plan.unitName).toMatch(/^agentbus-.*\.service$/);
    expect(plan.unitContent).toContain("ExecStart=");
    expect(plan.unitContent).toContain("daemon start");
    expect(plan.unitContent).toContain(BASE.configPath);
    expect(plan.unitContent).toContain("Restart=on-failure");
    expect(plan.unitPath).toContain(".config/systemd/user");
  });
});

describe("runAutostartInstall/Uninstall/Status（注入 runner）", () => {
  function fakeRunner(exitCode = 0) {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { exitCode, stdout: "", stderr: "" };
    };
    return { runner, calls };
  }

  it("install：经 reg 执行 createArgs 成功 → ok；报告含键名", async () => {
    const { runner, calls } = fakeRunner();
    const report = await runAutostartInstall({ ...BASE, runner });
    expect(report.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].bin).toBe("reg");
    expect(calls[0].args.join(" ")).toContain("add HKCU\\Software");
    expect(report.lines.join("\n")).toContain("AgentBus-default-accept-");
  });

  it("install：runner 非零退出 → ok=false 且透传 stderr", async () => {
    const { runner } = fakeRunner(1);
    const report = await runAutostartInstall({ ...BASE, runner });
    expect(report.ok).toBe(false);
  });

  it("linux install：写 unit 文件 + daemon-reload + enable（经 writeFile/runner 注入验证）", async () => {
    const { runner, calls } = fakeRunner();
    const written: Array<{ path: string; content: string }> = [];
    const report = await runAutostartInstall({
      ...BASE,
      platform: "linux",
      runner,
      writeFile: (path, content) => written.push({ path, content }),
    });
    expect(report.ok).toBe(true);
    expect(written.length).toBe(1);
    expect(written[0].content).toContain("ExecStart=");
    const joined = calls.map((c) => c.args.join(" ")).join("\n");
    expect(joined).toContain("daemon-reload");
    expect(joined).toContain("enable");
  });

  it("uninstall：win32 执行 deleteArgs；linux 走 disable + 删 unit", async () => {
    const { runner, calls } = fakeRunner();
    const report = await runAutostartUninstall({ ...BASE, runner });
    expect(report.ok).toBe(true);
    expect(calls[0].bin).toBe("reg");
    expect(calls[0].args.join(" ")).toContain("delete HKCU\\Software");

    const { runner: r2, calls: c2 } = fakeRunner();
    const removed: string[] = [];
    const report2 = await runAutostartUninstall({
      ...BASE,
      platform: "linux",
      runner: r2,
      removeFile: (p) => removed.push(p),
    });
    expect(report2.ok).toBe(true);
    expect(c2.map((c) => c.args.join(" ")).join("\n")).toContain("disable");
    expect(removed.length).toBe(1);
  });

  it("status：reg query exitCode 0 → 已注册；非零 → 未注册（不报错）", async () => {
    const up = await runAutostartStatus({ ...BASE, runner: fakeRunner(0).runner });
    expect(up.registered).toBe(true);
    const down = await runAutostartStatus({ ...BASE, runner: fakeRunner(1).runner });
    expect(down.registered).toBe(false);
  });
});
