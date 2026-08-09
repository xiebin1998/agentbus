/**
 * TASK-25 安全基线: listener TLS CA 支持（自签证书场景）
 *
 * 契约：broker.tls=true 时以 mqtts 连接并校验证书（rejectUnauthorized）；
 * 配置 broker.ca（CA 证书路径，支持 ${ENV} 引用）时加载该 CA 作为信任锚。
 * 抽出纯函数 buildConnectOptions 便于单测（真实 TLS 握手归真机冒烟）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConnectOptions } from "../src/daemon/listener.js";

describe("buildConnectOptions（TASK-25 TLS CA）", () => {
  it("非 TLS：固定身份与重连参数，无 ca/rejectUnauthorized", () => {
    const opts = buildConnectOptions({ host: "127.0.0.1", port: 18830 });
    expect(opts.clean).toBe(false);
    expect(opts.rejectUnauthorized).toBeFalsy();
    expect(opts.ca).toBeUndefined();
  });

  it("TLS 无 ca：rejectUnauthorized=true（信任系统 CA）", () => {
    const opts = buildConnectOptions({ host: "h", port: 8883, tls: true });
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toBeUndefined();
  });

  it("TLS + ca：加载 CA 文件内容作为信任锚", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-ca-"));
    const caFile = join(dir, "ca.crt");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----dummy-----END CERTIFICATE-----");
    const opts = buildConnectOptions({ host: "h", port: 8883, tls: true, ca: caFile });
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toHaveLength(1);
    expect((opts.ca as Buffer[])[0].toString()).toContain("dummy");
  });

  it("ca 指向不存在的文件时抛错（配置问题要显性暴露）", () => {
    expect(() =>
      buildConnectOptions({ host: "h", port: 8883, tls: true, ca: "/no/such/ca.crt" }),
    ).toThrow();
  });

  it("username/password 透传", () => {
    const opts = buildConnectOptions({ host: "h", port: 1883, username: "u", password: "p" });
    expect(opts.username).toBe("u");
    expect(opts.password).toBe("p");
  });
});
