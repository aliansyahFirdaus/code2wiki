import type { GitHubInstallationStatus } from "@code2wiki/shared";
import { createSign } from "node:crypto";

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

export type GitHubInstallationAccessToken = {
  token: string;
  expiresAt: string;
};

export async function createGitHubInstallationAccessToken(
  installationId: string
): Promise<GitHubInstallationAccessToken> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!appId) {
    throw new Error("GITHUB_APP_ID is required to create a GitHub installation token.");
  }

  if (!privateKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is required to create a GitHub installation token.");
  }

  const jwt = createGitHubAppJwt(appId, privateKey);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof payload.token !== "string" || !payload.token) {
    throw new Error("GitHub installation token response did not include a token.");
  }

  if (typeof payload.expires_at !== "string" || !payload.expires_at) {
    throw new Error("GitHub installation token response did not include an expiration timestamp.");
  }

  return { token: payload.token, expiresAt: payload.expires_at };
}

function createGitHubAppJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
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
