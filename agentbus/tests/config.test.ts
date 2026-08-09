/**
 * TASK-04: 配置系统（架构 4.4 / 8.3）
 * config.json 校验 + 缺省值 + ${ENV_VAR} 凭证解析
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveEnvRefs, validateConfig } from "../src/config.js";

const BASE = {
  client_id: "fe-zhangsan",
  ns: "iot",
  broker: { host: "192.168.1.10", port: 18830 },
  default_tool: "kilo",
  tools: { kilo: { binary: "kilo" } },
};

describe("validateConfig 必填与类型", () => {
  it("合法最小配置通过", () => {
    const r = validateConfig(BASE);
    expect(r.ok).toBe(true);
  });

  it("缺 client_id 报错且指明字段", () => {
    const { client_id, ...rest } = BASE;
    const r = validateConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("client_id");
  });

  it("broker.port 非数字报错", () => {
    const r = validateConfig({ ...BASE, broker: { host: "h", port: "abc" } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("broker.port");
  });

  it("default_tool 不在 tools 中报错", () => {
    const r = validateConfig({ ...BASE, default_tool: "claude" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("default_tool");
  });

  it("inbound_mode 非法值报错", () => {
    const r = validateConfig({ ...BASE, inbound_mode: "admin" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("inbound_mode");
  });

  it("非对象输入报错而非抛异常", () => {
    const r = validateConfig(null);
    expect(r.ok).toBe(false);
  });
});

describe("validateConfig 缺省值", () => {
  it("hop_limit/rate_limit/inbound_mode/ack 有架构默认值", () => {
    const r = validateConfig(BASE);
    expect(r.ok).toBe(true);
    expect(r.config!.hop_limit).toBe(3);
    expect(r.config!.rate_limit).toBe(5);
    expect(r.config!.inbound_mode).toBe("readonly");
    expect(r.config!.ack).toBe(true);
    expect(r.config!.allowed_senders).toEqual([]);
    expect(r.config!.trust_map).toEqual({});
  });

  it("显式值覆盖默认", () => {
    const r = validateConfig({ ...BASE, hop_limit: 1, inbound_mode: "full", ack: false });
    expect(r.config!.hop_limit).toBe(1);
    expect(r.config!.inbound_mode).toBe("full");
    expect(r.config!.ack).toBe(false);
  });

  it("trust_map 值必须是 readonly/full", () => {
    const r = validateConfig({ ...BASE, trust_map: { "ci-bot": "superuser" } });
    expect(r.ok).toBe(false);
  });
});

describe("resolveEnvRefs", () => {
  afterEach(() => {
    delete process.env.AGENTBUS_TEST_USER;
  });

  it("替换 ${VAR} 为环境变量值", () => {
    process.env.AGENTBUS_TEST_USER = "secret";
    expect(resolveEnvRefs("${AGENTBUS_TEST_USER}")).toBe("secret");
  });

  it("普通字符串原样返回", () => {
    expect(resolveEnvRefs("plain")).toBe("plain");
  });

  it("非字符串原样返回", () => {
    expect(resolveEnvRefs(undefined)).toBeUndefined();
    expect(resolveEnvRefs("")).toBe("");
  });

  it("环境变量缺失时抛 ConfigError 且指明变量名", () => {
    expect(() => resolveEnvRefs("${AGENTBUS_TEST_USER}")).toThrowError(ConfigError);
    expect(() => resolveEnvRefs("${AGENTBUS_TEST_USER}")).toThrowError(/AGENTBUS_TEST_USER/);
  });
});

describe("loadConfig", () => {
  it("读取并解析 ${ENV_VAR} 凭证", () => {
    process.env.AGENTBUS_TEST_USER = "u1";
    const dir = mkdtempSync(join(tmpdir(), "agentbus-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...BASE,
        broker: { ...BASE.broker, username: "${AGENTBUS_TEST_USER}", password: "" },
      }),
    );
    try {
      const cfg = loadConfig(file);
      expect(cfg.broker.username).toBe("u1");
    } finally {
      delete process.env.AGENTBUS_TEST_USER;
    }
  });

  it("非法 JSON 抛 ConfigError", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "{not json");
    expect(() => loadConfig(file)).toThrowError(ConfigError);
  });

  it("文件不存在抛 ConfigError", () => {
    expect(() => loadConfig(join(tmpdir(), "no-such-dir", "config.json"))).toThrowError(ConfigError);
  });
});
