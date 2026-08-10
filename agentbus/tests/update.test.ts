/**
 * agentbus update —— 客户端一键更新（npm 升级 → 重启 daemon）
 *
 * 背景：iwr 安装脚本与 npm 全局安装本质相同（脚本内部即 npm install -g + init），
 * 但重跑安装脚本会经 init --yes 覆盖既有 config.json（broker/凭证/ns），
 * 故更新走独立命令：只升包 + 重启 daemon，配置/MCP 注册/skill 不动。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDaemonRunning, planUpgrade, resolveUpdateSource } from "../src/update.js";

describe("resolveUpdateSource（升级包来源）", () => {
  it("默认 @xiebin1998/agentbus@latest", () => {
    expect(resolveUpdateSource({})).toBe("@xiebin1998/agentbus@latest");
  });

  it("AGENTBUS_PACKAGE 优先（离线环境指本地目录/tarball，与 install.ps1 同一机制）", () => {
    expect(resolveUpdateSource({ AGENTBUS_PACKAGE: "./agentbus.tgz" })).toBe("./agentbus.tgz");
  });
});

describe("planUpgrade（升级步骤计划）", () => {
  it("npm 全局安装指定包源", () => {
    const plan = planUpgrade("@xiebin1998/agentbus@latest");
    expect(plan.steps).toEqual([{ cmd: "npm", args: ["install", "-g", "@xiebin1998/agentbus@latest"] }]);
  });
});

describe("isDaemonRunning（workDir 的 pid 判定，复用 daemon stop 的口径）", () => {
  it("无 daemon.pid → 未运行", () => {
    const dir = mkdtempSync(join(tmpdir(), "upd-"));
    expect(isDaemonRunning(dir).running).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stale pid（进程不存在）→ 未运行", () => {
    const dir = mkdtempSync(join(tmpdir(), "upd-"));
    writeFileSync(join(dir, "daemon.pid"), "99999999");
    expect(isDaemonRunning(dir).running).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("活进程 pid → 运行中且返回 pid（update 需先停旧进程再提示拉起）", () => {
    const dir = mkdtempSync(join(tmpdir(), "upd-"));
    writeFileSync(join(dir, "daemon.pid"), String(process.pid));
    const st = isDaemonRunning(dir);
    expect(st.running).toBe(true);
    expect(st.pid).toBe(process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("workDir 不存在也不抛（未 init 的项目跑 update 只升级 CLI）", () => {
    expect(isDaemonRunning(join(tmpdir(), "no-such-dir-upd")).running).toBe(false);
  });
});

describe("cli.ts 接线", () => {
  it("注册 update 子命令", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "utf-8");
    expect(src).toContain('.command("update")');
  });
});
