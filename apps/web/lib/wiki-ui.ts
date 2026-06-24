export type WikiPageLabelInput = {
  generationStrategy?: string | null;
  reusedFromGenerationRunId?: string | null;
};

export type EvidenceGroupInput = {
  id: string;
  repositoryRole?: "FRONTEND" | "BACKEND" | string | null;
  filePath?: string | null;
};

export type EvidenceFileGroup<T extends EvidenceGroupInput> = {
  filePath: string;
  items: T[];
};

export type EvidenceRoleGroup<T extends EvidenceGroupInput> = {
  role: string;
  files: Array<EvidenceFileGroup<T>>;
};

export function pageStatusLabel(page: WikiPageLabelInput): string {
  if (page.reusedFromGenerationRunId) {
    return "Reused";
  }
  if (!page.generationStrategy) {
    return "Generated";
  }

  return titleCase(page.generationStrategy.replace(/_/g, " ").toLowerCase());
}

export function groupEvidenceByRoleAndFile<T extends EvidenceGroupInput>(items: T[]): Array<EvidenceRoleGroup<T>> {
  const roleGroups = new Map<string, Map<string, T[]>>();

  for (const item of items) {
    const role = item.repositoryRole || "Ungrouped";
    const filePath = item.filePath || "Unknown file";
    const files = roleGroups.get(role) ?? new Map<string, T[]>();
    files.set(filePath, [...(files.get(filePath) ?? []), item]);
    roleGroups.set(role, files);
  }

  return [...roleGroups.entries()].map(([role, files]) => ({
    role,
    files: [...files.entries()].map(([filePath, groupItems]) => ({ filePath, items: groupItems }))
  }));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
