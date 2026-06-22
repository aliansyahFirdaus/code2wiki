import type { GitHubInstallationStatus } from "@code2wiki/shared";

export type GitHubInstallationCallbackInput = {
  installationId: string;
  setupAction: string | null;
  workspaceId: string;
  status: GitHubInstallationStatus;
};

export function decodeWorkspaceIdFromState(state: string | null): string | null {
  if (!state) {
    return null;
  }

  for (const value of [state, decodeBase64Url(state)]) {
    if (!value) {
      continue;
    }

    try {
      const parsed = JSON.parse(value) as { workspaceId?: unknown };
      return typeof parsed.workspaceId === "string" && parsed.workspaceId.trim() ? parsed.workspaceId.trim() : null;
    } catch {
      continue;
    }
  }

  return null;
}

export function mapSetupActionToInstallationStatus(setupAction: string | null): GitHubInstallationStatus {
  switch (setupAction?.toLowerCase()) {
    case "install":
    case "installed":
      return "INSTALLED";
    case "update":
    case "updated":
      return "UPDATED";
    case "remove":
    case "removed":
    case "uninstall":
      return "REMOVED";
    default:
      return "UNKNOWN";
  }
}

function decodeBase64Url(value: string) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}
