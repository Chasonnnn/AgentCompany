import type { ConferenceRoomKind } from "../constants.js";

export interface ConnectionContractCadence {
  workerUpdates?: string | null;
  teamLeadSummary?: string | null;
  projectLeadershipCheckIn?: string | null;
  executiveReview?: string | null;
  incidentUpdate?: string | null;
  consultingCloseout?: string | null;
  milestoneReset?: string | null;
}

export interface ConnectionContract {
  upstreamInputs: string[];
  downstreamOutputs: string[];
  ownedArtifacts: string[];
  delegationRights: string[];
  reviewRights: string[];
  escalationPath: string[];
  standingRooms: string[];
  scopeBoundaries: string[];
  cadence: ConnectionContractCadence | null;
}

export type ConnectionContractKind = "paperclip/connection-contract.v1";

export type PaperclipPacketKind =
  | "paperclip/assignment.v1"
  | "paperclip/heartbeat.v1"
  | "paperclip/decision-request.v1"
  | "paperclip/review-request.v1"
  | "paperclip/escalation.v1";

export interface AssignmentPacket {
  kind: "paperclip/assignment.v1";
  owner?: string | null;
  requestedBy?: string | null;
  parentTask?: string | null;
  objective?: string | null;
  scope?: string | null;
  nonGoals?: string[];
  dependencies?: string[];
  definitionOfDone?: string[];
  references?: string[];
  deadline?: string | null;
  priority?: string | null;
  escalateIf?: string[];
}

export interface HeartbeatPacket {
  kind: "paperclip/heartbeat.v1";
  state?: "green" | "yellow" | "red" | null;
  progress?: string | null;
  completedSinceLastUpdate?: string[];
  nextActions?: string[];
  blockers?: string[];
  needFromManager?: string[];
  artifactsUpdated?: string[];
}

export interface DecisionRequestPacket {
  kind: "paperclip/decision-request.v1";
  decisionNeeded?: string | null;
  whyNow?: string | null;
  optionsConsidered?: string[];
  recommendedOption?: string | null;
  tradeoffs?: string[];
  impactIfDelayed?: string | null;
  references?: string[];
}

export interface ReviewRequestPacket {
  kind: "paperclip/review-request.v1";
  reviewType?: string | null;
  scope?: string | null;
  acceptanceCriteria?: string[];
  specificQuestions?: string[];
  deadline?: string | null;
  artifacts?: string[];
}

export interface EscalationPacket {
  kind: "paperclip/escalation.v1";
  problem?: string | null;
  currentOwner?: string | null;
  whyBlocked?: string | null;
  attempted?: string[];
  neededDecisionOrResource?: string | null;
  affectedParties?: string[];
  timeSensitivity?: string | null;
}

export type PacketEnvelope =
  | AssignmentPacket
  | HeartbeatPacket
  | DecisionRequestPacket
  | ReviewRequestPacket
  | EscalationPacket;

export interface ParsedPacketEnvelope {
  envelope: PacketEnvelope;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface ParsedConnectionContract {
  connectionContractKind: ConnectionContractKind;
  connectionContract: ConnectionContract;
  body: string;
  frontmatter: Record<string, unknown>;
}

export type IssueProgressDocumentKind = "paperclip/issue-progress.v1";
export type IssueHandoffDocumentKind = "paperclip/issue-handoff.v1";
export type IssueBranchCharterKind = "paperclip/issue-branch-charter.v1";
export type IssueContinuityDocumentKind =
  | IssueProgressDocumentKind
  | IssueHandoffDocumentKind
  | IssueBranchCharterKind;

export interface IssueProgressCheckpoint {
  at?: string | null;
  completed: string[];
  currentState: string;
  knownPitfalls: string[];
  nextAction: string;
  openQuestions: string[];
  evidence: string[];
}

export interface IssueProgressDocument {
  kind: IssueProgressDocumentKind;
  summary?: string | null;
  currentState: string;
  knownPitfalls: string[];
  nextAction: string;
  openQuestions: string[];
  evidence: string[];
  checkpoints: IssueProgressCheckpoint[];
}

export interface IssueHandoffDocument {
  kind: IssueHandoffDocumentKind;
  reasonCode: string;
  timestamp: string;
  transferTarget: string;
  exactNextAction: string;
  unresolvedBranches: string[];
  openQuestions: string[];
  evidence: string[];
}

export interface IssueBranchCharter {
  kind: IssueBranchCharterKind;
  purpose: string;
  scope: string;
  budget: string;
  expectedReturnArtifact: string;
  mergeCriteria: string[];
  expiration?: string | null;
  timeout?: string | null;
}

export interface ParsedIssueProgressDocument {
  document: IssueProgressDocument;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface ParsedIssueHandoffDocument {
  document: IssueHandoffDocument;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface ParsedIssueBranchCharter {
  document: IssueBranchCharter;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface ReservedDocumentDescriptor {
  key: string;
  label: string;
  owner: string;
  description: string;
}

export interface ConferenceRoomKindDescriptor {
  kind: ConferenceRoomKind;
  label: string;
  description: string;
}
