/**
 * npm 包名契约：发布 scope 为 @xiebin1998/agentbus
 *
 * 契约：package.json name、一键安装脚本默认安装源均使用 @xiebin1998 scope。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = "@xiebin1998/agentbus";

describe("npm 包名 scope（@xiebin1998/agentbus）", () => {
  it("package.json name 与发布 scope 一致", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "agentbus", "package.json"), "utf-8"));
    expect(pkg.name).toBe(PKG);
  });

  it("install.ps1 默认安装源为 @xiebin1998/agentbus@latest", () => {
    const src = readFileSync(join(repoRoot, "scripts", "install.ps1"), "utf-8");
    expect(src).toContain(`${PKG}@latest`);
    expect(src).not.toContain("@agenthub/agentbus");
  });

  it("install.sh 默认安装源为 @xiebin1998/agentbus@latest", () => {
    const src = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf-8");
    expect(src).toContain(`${PKG}@latest`);
    expect(src).not.toContain("@agenthub/agentbus");
  });
});
