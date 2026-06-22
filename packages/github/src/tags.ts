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
