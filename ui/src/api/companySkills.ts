import type {
  BulkSkillGrantApplyRequest,
  BulkSkillGrantPreview,
  BulkSkillGrantRequest,
  BulkSkillGrantResult,
  CompanySkill,
  CompanySkillCoverageAudit,
  CompanySkillCoverageRepairApplyRequest,
  CompanySkillCoverageRepairPreview,
  CompanySkillCoverageRepairResult,
  CompanySkillInstallGlobalAllResult,
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillInstallGlobalRequest,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillReliabilityAudit,
  CompanySkillReliabilityRepairApplyRequest,
  CompanySkillReliabilityRepairPreview,
  CompanySkillReliabilityRepairResult,
  CompanySkillReliabilitySweepRequest,
  CompanySkillReliabilitySweepResult,
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
  coverageAudit: (companyId: string) =>
    api.get<CompanySkillCoverageAudit>(
      `/companies/${encodeURIComponent(companyId)}/skills/coverage-audit`,
    ),
  coverageRepairPreview: (companyId: string) =>
    api.post<CompanySkillCoverageRepairPreview>(
      `/companies/${encodeURIComponent(companyId)}/skills/coverage-audit/repair-preview`,
      {},
    ),
  coverageRepairApply: (companyId: string, payload: CompanySkillCoverageRepairApplyRequest) =>
    api.post<CompanySkillCoverageRepairResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/coverage-audit/repair-apply`,
      payload,
    ),
  reliabilityAudit: (companyId: string) =>
    api.get<CompanySkillReliabilityAudit>(
      `/companies/${encodeURIComponent(companyId)}/skills/reliability-audit`,
    ),
  reliabilityRepairPreview: (companyId: string) =>
    api.post<CompanySkillReliabilityRepairPreview>(
      `/companies/${encodeURIComponent(companyId)}/skills/reliability-audit/repair-preview`,
      {},
    ),
  reliabilityRepairApply: (companyId: string, payload: CompanySkillReliabilityRepairApplyRequest) =>
    api.post<CompanySkillReliabilityRepairResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/reliability-audit/repair-apply`,
      payload,
    ),
  reliabilitySweep: (companyId: string, payload: CompanySkillReliabilitySweepRequest) =>
    api.post<CompanySkillReliabilitySweepResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/reliability-sweep`,
      payload,
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
  installAllGlobal: (companyId: string) =>
    api.post<CompanySkillInstallGlobalAllResult>(
      `/companies/${encodeURIComponent(companyId)}/skills/install-global-all`,
      {},
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
