export type MemoryScope = "agent" | "company";

export type MemoryHealthStatus = "ok" | "warning" | "over_limit";

export interface MemoryFileSummary {
  path: string;
  layer: string;
  size: number;
  language: string;
  markdown: boolean;
  editable: boolean;
  archived: boolean;
}

export interface MemoryFileDetail extends MemoryFileSummary {
  content: string;
  truncated: boolean;
  fullSize: number;
}

export interface AgentMemoryOverview {
  agentId: string;
  companyId: string;
  rootPath: string;
  hotPath: string;
  legacyBundleMemoryPath: string | null;
  hotBytes: number;
  warningBytes: number;
  targetBytes: number;
  hardLimitBytes: number;
  status: MemoryHealthStatus;
  files: MemoryFileSummary[];
  warnings: string[];
}

export interface CompanyMemoryOverview {
  companyId: string;
  rootPath: string;
  files: MemoryFileSummary[];
  warnings: string[];
}

export interface MemoryMigrationResult {
  archivePath: string;
  oldBytes: number;
  newHotBytes: number;
  createdFiles: string[];
  updatedFiles: string[];
  overview: AgentMemoryOverview;
}
