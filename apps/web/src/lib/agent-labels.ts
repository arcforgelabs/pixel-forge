import { capitalize } from "@/lib/utils";

export interface ProviderLabelRecord {
  id: string;
  display_name?: string | null;
}

export function formatAgentToolLabel(tool: string | null | undefined): string {
  if (!tool || !tool.trim()) {
    return "Agent";
  }

  return tool === "claude"
    ? "Claude Code"
    : tool === "codex"
      ? "Codex"
      : tool === "cursor"
        ? "Cursor"
        : tool === "gemini"
        ? "Gemini"
        : tool === "pi"
          ? "Pi"
          : tool === "openclaw"
            ? "OpenClaw"
            : capitalize(tool);
}

export function formatProviderLabel(
  providerId: string | null | undefined,
  providers: ProviderLabelRecord[] = []
): string {
  const normalizedProviderId = providerId?.trim() || null;
  if (!normalizedProviderId) {
    return "Provider";
  }

  const provider = providers.find((entry) => entry.id === normalizedProviderId);
  const displayName = provider?.display_name?.trim();
  if (displayName) {
    return displayName;
  }

  if (normalizedProviderId === "agent-deck") {
    return "Agent Deck";
  }
  if (normalizedProviderId === "claude-cli") {
    return "Claude CLI";
  }
  if (normalizedProviderId === "codex-cli") {
    return "Codex CLI";
  }
  if (normalizedProviderId === "cursor-cli") {
    return "Cursor CLI";
  }

  return capitalize(normalizedProviderId.replace(/[-_]+/g, " "));
}
