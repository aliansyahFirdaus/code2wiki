import type { RepositoryRole } from "@code2wiki/shared";

type RepositoryWithRole = {
  id: string;
  role: RepositoryRole;
};

export type ScanCoverageInput = {
  repositoryRole: RepositoryRole;
  totalEligibleFiles: number;
  indexedEligibleFiles: number;
};

export type ScanCoverage = {
  totalEligibleFiles: number;
  indexedEligibleFiles: number;
  frontendTotalEligibleFiles: number;
  frontendIndexedEligibleFiles: number;
  backendTotalEligibleFiles: number;
  backendIndexedEligibleFiles: number;
};

export function assertGenerationRepositoryRoles(frontendRepository: RepositoryWithRole, backendRepository: RepositoryWithRole) {
  if (frontendRepository.role !== "FRONTEND") {
    throw new Error(`frontendRepositoryId ${frontendRepository.id} resolved to ${frontendRepository.role}.`);
  }
  if (backendRepository.role !== "BACKEND") {
    throw new Error(`backendRepositoryId ${backendRepository.id} resolved to ${backendRepository.role}.`);
  }
}

export function mapScanCoverage(scans: ScanCoverageInput[]): ScanCoverage {
  const coverage: ScanCoverage = {
    totalEligibleFiles: 0,
    indexedEligibleFiles: 0,
    frontendTotalEligibleFiles: 0,
    frontendIndexedEligibleFiles: 0,
    backendTotalEligibleFiles: 0,
    backendIndexedEligibleFiles: 0
  };

  for (const scan of scans) {
    coverage.totalEligibleFiles += scan.totalEligibleFiles;
    coverage.indexedEligibleFiles += scan.indexedEligibleFiles;

    if (scan.repositoryRole === "FRONTEND") {
      coverage.frontendTotalEligibleFiles = scan.totalEligibleFiles;
      coverage.frontendIndexedEligibleFiles = scan.indexedEligibleFiles;
    } else {
      coverage.backendTotalEligibleFiles = scan.totalEligibleFiles;
      coverage.backendIndexedEligibleFiles = scan.indexedEligibleFiles;
    }
  }

  return coverage;
}
