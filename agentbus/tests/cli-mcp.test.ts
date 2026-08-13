import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";

// Verify the mcp command exists in the CLI
describe("agentbus mcp command", () => {
  it("registers mcp command", () => {
    const program = buildProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
  });

  it("mcp command has --stdio option", () => {
    const program = buildProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const stdioOpt = mcpCmd?.options.find((o) => o.long === "--stdio");
    expect(stdioOpt).toBeDefined();
  });

  it("mcp command has --daemon option", () => {
    const program = buildProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const daemonOpt = mcpCmd?.options.find((o) => o.long === "--daemon");
    expect(daemonOpt).toBeDefined();
  });
});
