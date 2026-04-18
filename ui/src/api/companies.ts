import type {
  Company,
  CompanyDocument,
  CompanyDocumentRevision,
  CompanyDocumentSummary,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  TeamDocument,
  TeamDocumentRevision,
  TeamDocumentSummary,
  UpsertProjectDocument,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import { api } from "./client";

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) =>
    api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "requireBoardApprovalForNewAgents"
        | "feedbackDataSharingEnabled"
        | "brandColor"
        | "logoAssetId"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  listDocuments: (companyId: string) => api.get<CompanyDocumentSummary[]>(`/companies/${companyId}/documents`),
  getDocument: (companyId: string, key: string) =>
    api.get<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (companyId: string, key: string, data: UpsertProjectDocument) =>
    api.put<CompanyDocument>(`/companies/${companyId}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (companyId: string, key: string) =>
    api.get<CompanyDocumentRevision[]>(`/companies/${companyId}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (companyId: string, key: string, revisionId: string) =>
    api.post<CompanyDocument>(
      `/companies/${companyId}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      {},
    ),
  listTeamDocuments: (companyId: string) => api.get<TeamDocumentSummary[]>(`/companies/${companyId}/team-documents`),
  getTeamDocument: (companyId: string, departmentKey: string, key: string, departmentName?: string | null) =>
    api.get<TeamDocument>(
      `/companies/${companyId}/team-documents/${encodeURIComponent(departmentKey)}/${encodeURIComponent(key)}${departmentName ? `?departmentName=${encodeURIComponent(departmentName)}` : ""}`,
    ),
  upsertTeamDocument: (
    companyId: string,
    departmentKey: string,
    key: string,
    data: UpsertProjectDocument,
    departmentName?: string | null,
  ) =>
    api.put<TeamDocument>(
      `/companies/${companyId}/team-documents/${encodeURIComponent(departmentKey)}/${encodeURIComponent(key)}${departmentName ? `?departmentName=${encodeURIComponent(departmentName)}` : ""}`,
      data,
    ),
  listTeamDocumentRevisions: (companyId: string, departmentKey: string, key: string, departmentName?: string | null) =>
    api.get<TeamDocumentRevision[]>(
      `/companies/${companyId}/team-documents/${encodeURIComponent(departmentKey)}/${encodeURIComponent(key)}/revisions${departmentName ? `?departmentName=${encodeURIComponent(departmentName)}` : ""}`,
    ),
  restoreTeamDocumentRevision: (
    companyId: string,
    departmentKey: string,
    key: string,
    revisionId: string,
    departmentName?: string | null,
  ) =>
    api.post<TeamDocument>(
      `/companies/${companyId}/team-documents/${encodeURIComponent(departmentKey)}/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore${departmentName ? `?departmentName=${encodeURIComponent(departmentName)}` : ""}`,
      {},
    ),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/export`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  exportPackage: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
};
