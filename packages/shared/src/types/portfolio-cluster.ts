import type { PortfolioClusterStatus } from "../constants.js";

export interface PortfolioCluster {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  summary: string | null;
  status: PortfolioClusterStatus;
  sortOrder: number;
  executiveSponsorAgentId: string | null;
  portfolioDirectorAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioClusterCreateRequest {
  name: string;
  slug?: string | null;
  summary?: string | null;
  status?: PortfolioClusterStatus;
  sortOrder?: number;
  executiveSponsorAgentId?: string | null;
  portfolioDirectorAgentId?: string | null;
}

export interface PortfolioClusterUpdateRequest {
  name?: string;
  slug?: string | null;
  summary?: string | null;
  status?: PortfolioClusterStatus;
  sortOrder?: number;
  executiveSponsorAgentId?: string | null;
  portfolioDirectorAgentId?: string | null;
}
