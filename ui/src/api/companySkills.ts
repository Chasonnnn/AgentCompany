import type {
  BulkSkillGrantApplyRequest,
  BulkSkillGrantPreview,
  BulkSkillGrantRequest,
  BulkSkillGrantResult,
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillInstallGlobalRequest,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillUpdateStatus,
  GlobalSkillCatalogItem,
} from "@paperclipai/shared";
import { api } from "./client";

export const companySkillsApi = {
  list: (companyId: string) =>
    api.get<CompanySkillListItem[]>(`/companies/${encodeURIComponent(companyId)}/skills`),
  globalCatalog: (companyId: string) =>
    api.get<GlobalSkillCatalogItem[]>(
      `/companies/${encodeURIComponent(companyId)}/skills/global-catalog`,
    ),
  detail: (companyId: string, skillId: string) =>
    api.get<CompanySkillDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
    ),
  updateStatus: (companyId: string, skillId: string) =>
    api.get<CompanySkillUpdateStatus>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/update-status`,
    ),
  file: (companyId: string, skillId: string, relativePath: string) =>
    api.get<CompanySkillFileDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(relativePath)}`,
    ),
  updateFile: (companyId: string, skillId: string, path: string, content: string) =>
    api.patch<CompanySkillFileDetail>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files`,
      { path, content },
    ),
  create: (companyId: string, payload: CompanySkillCreateRequest) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills`,
      payload,
    ),
  importFromSource: (companyId: string, source: string) =>
    api.post<CompanySkillImportResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/import`,
      { source },
    ),
  installGlobal: (companyId: string, payload: CompanySkillInstallGlobalRequest) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/install-global`,
      payload,
    ),
  bulkGrantPreview: (companyId: string, skillId: string, payload: BulkSkillGrantRequest) =>
    api.post<BulkSkillGrantPreview>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/bulk-preview`,
      payload,
    ),
  bulkGrantApply: (companyId: string, skillId: string, payload: BulkSkillGrantApplyRequest) =>
    api.post<BulkSkillGrantResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/bulk-apply`,
      payload,
    ),
  scanProjects: (companyId: string, payload: CompanySkillProjectScanRequest = {}) =>
    api.post<CompanySkillProjectScanResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/scan-projects`,
      payload,
    ),
  installUpdate: (companyId: string, skillId: string) =>
    api.post<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/install-update`,
      {},
    ),
  delete: (companyId: string, skillId: string) =>
    api.delete<CompanySkill>(
      `/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}`,
    ),
};
