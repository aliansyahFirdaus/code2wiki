import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CloneRepositoryAtCommitInput = {
  owner: string;
  repo: string;
  commitSha: string;
  token: string;
};

export type RepositoryCheckout = {
  path: string;
  head: string;
  remoteUrl: string;
  cleanup: () => Promise<void>;
};

export async function cloneRepositoryAtCommit(input: CloneRepositoryAtCommitInput): Promise<RepositoryCheckout> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "code2wiki-"));
  const askpassPath = path.join(tempRoot, "git-askpass.sh");
  const repoPath = path.join(tempRoot, "repo");
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;

  const cleanup = async () => {
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    await writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  *Username*) printf '%s\\n' 'x-access-token' ;;",
        "  *Password*) printf '%s\\n' \"$CODE2WIKI_GITHUB_TOKEN\" ;;",
        "  *) printf '\\n' ;;",
        "esac",
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(askpassPath, 0o700);

    const gitEnv = {
      ...process.env,
      CODE2WIKI_GITHUB_TOKEN: input.token,
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0"
    };

    await runGit(["clone", "--no-checkout", remoteUrl, repoPath], tempRoot, gitEnv);

    const storedRemoteUrl = (await runGit(["config", "--get", "remote.origin.url"], repoPath, gitEnv)).trim();
    if (remoteUrlHasCredentials(storedRemoteUrl)) {
      throw new Error("Git remote URL contains credentials after clone.");
    }

    await runGit(["checkout", "--detach", input.commitSha], repoPath, gitEnv);
    const head = (await runGit(["rev-parse", "HEAD"], repoPath, gitEnv)).trim();
    if (head.toLowerCase() !== input.commitSha.toLowerCase()) {
      throw new Error("Checked out HEAD does not match the expected commit SHA.");
    }

    return {
      path: repoPath,
      head,
      remoteUrl: storedRemoteUrl,
      cleanup
    };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // Cleanup failure must not mask the primary clone or checkout error.
    }
    throw error;
  }
}

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024
    });

    return stdout;
  } catch (error) {
    throw new Error(`Git command failed: git ${args.map(redactGitArg).join(" ")}`);
  }
}

function remoteUrlHasCredentials(remoteUrl: string) {
  try {
    const parsed = new URL(remoteUrl);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /\/\/[^/\s@]+@/.test(remoteUrl);
  }
}

function redactGitArg(arg: string) {
  if (/^https:\/\/[^/\s@]+:[^@\s]+@/i.test(arg)) {
    return "https://[redacted]@github.com/[redacted]";
  }

  return arg;
}
