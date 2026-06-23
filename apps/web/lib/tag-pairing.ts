import type { RepositoryRole } from "@code2wiki/shared";

export type TagPairEvent = {
  id: string;
  repositoryId: string;
  role: RepositoryRole;
  tag: string;
  commitSha: string;
};

export type GenerationPair = {
  frontend: TagPairEvent;
  backend: TagPairEvent;
};

export function oppositeRepositoryRole(role: RepositoryRole): RepositoryRole {
  return role === "FRONTEND" ? "BACKEND" : "FRONTEND";
}

export function buildGenerationPair(current: TagPairEvent, opposite: TagPairEvent): GenerationPair | null {
  if (current.role === opposite.role) {
    return null;
  }

  return current.role === "FRONTEND"
    ? { frontend: current, backend: opposite }
    : { frontend: opposite, backend: current };
}
