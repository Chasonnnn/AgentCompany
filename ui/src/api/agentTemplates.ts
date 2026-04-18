import type { AgentTemplate } from "@paperclipai/shared";
import { api } from "./client";

export const agentTemplatesApi = {
  list: (companyId: string) => api.get<AgentTemplate[]>(`/companies/${companyId}/agent-templates`),
};
