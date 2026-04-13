import type {
  EvalRunArtifact,
  EvalRunListItem,
  EvalSummaryIndex,
} from "@paperclipai/shared";
import { api } from "./client";

export const evalsApi = {
  getSummary: () => api.get<EvalSummaryIndex>("/instance/evals/summary"),
  listRuns: () => api.get<EvalRunListItem[]>("/instance/evals/runs"),
  getRun: (runId: string) => api.get<EvalRunArtifact>(`/instance/evals/runs/${runId}`),
};
