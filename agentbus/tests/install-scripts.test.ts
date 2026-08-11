/**
 * TASK-28: 一键安装脚本内容契约（架构 6.6 / PLAN T24）
 *
 * 契约：install.ps1 / install.sh 内部 = 装 agentbus CLI（npm 全局）→ init --yes → doctor；
 * 含 Node 版本门槛（>=18，架构 6.7）与错误/离线提示。干净机器一条命令接入的真机验收另记。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ps1Path = join(repoRoot, "scripts", "install.ps1");
const shPath = join(repoRoot, "scripts", "install.sh");
const publishPath = join(repoRoot, "scripts", "publish.ps1");

describe("install.ps1（Windows 一键安装）", () => {
  it("存在且含三步主流程：npm 安装 → init --yes → doctor", () => {
    expect(existsSync(ps1Path)).toBe(true);
    const src = readFileSync(ps1Path, "utf-8");
    expect(src).toMatch(/npm install -g/);
    expect(src).toMatch(/init --yes/);
    expect(src).toMatch(/doctor/);
  });

  it("Node 版本门槛 >=18 与失败提示（错误处理/离线提示，PLAN T24）", () => {
    const src = readFileSync(ps1Path, "utf-8");
    expect(src).toMatch(/18/);
    expect(src).toMatch(/node/i);
    expect(src).toMatch(/npm/i);
    // 失败收敛：有显式错误输出与退出码
    expect(src).toMatch(/exit 1|throw|Write-Error/);
  });
});

describe("install.sh（macOS/Linux 一键安装）", () => {
  it("存在且含三步主流程：npm 安装 → init --yes → doctor", () => {
    expect(existsSync(shPath)).toBe(true);
    const src = readFileSync(shPath, "utf-8");
    expect(src.startsWith("#!/")).toBe(true);
    expect(src).toMatch(/npm install -g/);
    expect(src).toMatch(/init --yes/);
    expect(src).toMatch(/doctor/);
  });

  it("Node 版本门槛 >=18 与错误即停（set -e 或等价）", () => {
    const src = readFileSync(shPath, "utf-8");
    expect(src).toMatch(/18/);
    expect(src).toMatch(/set -e|exit 1/);
  });

  it("LF 行尾（CRLF 的 sh 脚本经 bash 执行会失败；托管给 Linux/macOS 用户）", () => {
    const src = readFileSync(shPath, "utf-8");
    expect(src).not.toMatch(/\r/);
  });
});

describe("publish.ps1（npm 一键发布）", () => {
  it("存在且含主流程：版本升级 → 构建 → publish --access public（OTP 可选）", () => {
    expect(existsSync(publishPath)).toBe(true);
    const src = readFileSync(publishPath, "utf-8");
    expect(src).toMatch(/npm(\.cmd)? version/);
    expect(src).toMatch(/npm(\.cmd)? run build/);
    expect(src).toMatch(/npm(\.cmd)? @?pubArgs|npm(\.cmd)? publish/);
    expect(src).toMatch(/--access/);
    // OTP 可选：填了才拼 --otp（bypass-2FA granular token 不需要，带了反而 EOTP）
    expect(src).toMatch(/--otp/);
    expect(src).toMatch(/if \(\$otp\)/);
  });

  it("发布前跑单测（防坏版本上 registry）且失败即停", () => {
    const src = readFileSync(publishPath, "utf-8");
    expect(src).toMatch(/npm(\.cmd)? test|vitest/);
    expect(src).toMatch(/\$ErrorActionPreference\s*=\s*"Stop"|throw|exit 1/);
  });

  it("OTP 交互输入（支持 6 位动态码或 64 位恢复码）", () => {
    const src = readFileSync(publishPath, "utf-8");
    expect(src).toMatch(/Read-Host/);
    expect(src).toMatch(/\{6\}|\{64\}/);
  });
});
