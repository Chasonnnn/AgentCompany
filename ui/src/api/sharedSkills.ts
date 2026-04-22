import type {
  SharedSkillProposal,
  SharedSkillProposalVerificationUpdateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const sharedSkillsApi = {
  listProposals: (status?: string) =>
    api.get<SharedSkillProposal[]>(
      `/instance/shared-skills/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  getProposal: (proposalId: string) =>
    api.get<SharedSkillProposal>(`/instance/shared-skills/proposals/${encodeURIComponent(proposalId)}`),
  approveProposal: (proposalId: string, decisionNote?: string | null) =>
    api.post<SharedSkillProposal>(
      `/instance/shared-skills/proposals/${encodeURIComponent(proposalId)}/approve`,
      decisionNote ? { decisionNote } : {},
    ),
  rejectProposal: (proposalId: string, decisionNote?: string | null) =>
    api.post<SharedSkillProposal>(
      `/instance/shared-skills/proposals/${encodeURIComponent(proposalId)}/reject`,
      decisionNote ? { decisionNote } : {},
    ),
  requestRevision: (proposalId: string, decisionNote?: string | null) =>
    api.post<SharedSkillProposal>(
      `/instance/shared-skills/proposals/${encodeURIComponent(proposalId)}/request-revision`,
      decisionNote ? { decisionNote } : {},
    ),
  updateProposalVerification: (
    proposalId: string,
    payload: SharedSkillProposalVerificationUpdateRequest,
  ) =>
    api.patch<SharedSkillProposal>(
      `/instance/shared-skills/proposals/${encodeURIComponent(proposalId)}/verification`,
      payload,
    ),
};
