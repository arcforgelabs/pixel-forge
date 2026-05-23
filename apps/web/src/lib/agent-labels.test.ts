import { describe, expect, it } from "vitest";
import { formatAgentToolLabel, formatProviderLabel } from "./agent-labels";

describe("agent labels", () => {
  it("formats native agent names without Agent Deck wording", () => {
    expect(formatAgentToolLabel("claude")).toBe("Claude Code");
    expect(formatAgentToolLabel("codex")).toBe("Codex");
    expect(formatAgentToolLabel("cursor")).toBe("Cursor");
    expect(formatAgentToolLabel("openclaw")).toBe("OpenClaw");
  });

  it("formats provider labels from provider records or known direct ids", () => {
    expect(formatProviderLabel("codex-cli")).toBe("Codex CLI");
    expect(formatProviderLabel("claude-cli")).toBe("Claude CLI");
    expect(formatProviderLabel("cursor-cli")).toBe("Cursor CLI");
    expect(
      formatProviderLabel("custom-provider", [
        { id: "custom-provider", display_name: "Custom Provider" },
      ])
    ).toBe("Custom Provider");
  });
});
