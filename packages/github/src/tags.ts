export function isFortyCharCommitSha(value: string) {
  return /^[0-9a-f]{40}$/i.test(value);
}

export function isZeroCommitSha(value: string) {
  return /^0{40}$/.test(value);
}

export function matchesTagPattern(tagPattern: string, tag: string) {
  const pattern = tagPattern.trim();
  if (!pattern) {
    return false;
  }

  const regexSource = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${regexSource}$`).test(tag);
}

export type LatestMatchingTagInput = {
  owner: string;
  repo: string;
  tagPattern: string;
  token: string;
};

export type LatestMatchingTag = {
  tag: string;
  commitSha: string;
};

type GitHubTagApiItem = {
  name?: unknown;
  commit?: {
    sha?: unknown;
  } | null;
};

export async function findLatestMatchingTag(input: LatestMatchingTagInput): Promise<LatestMatchingTag> {
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/tags?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub tags request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("GitHub tags response was not an array.");
    }

    for (const item of payload as GitHubTagApiItem[]) {
      if (typeof item.name !== "string" || !matchesTagPattern(input.tagPattern, item.name)) {
        continue;
      }
      if (!isFortyCharCommitSha(item.commit?.sha as string)) {
        continue;
      }

      return { tag: item.name, commitSha: item.commit!.sha as string };
    }

    if (payload.length < 100) {
      break;
    }
  }

  throw new Error(`No matching tags found for ${input.owner}/${input.repo} with pattern ${input.tagPattern}.`);
}
