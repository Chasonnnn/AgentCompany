import type { InReviewSelfAttest } from "@paperclipai/shared";

export interface InReviewEntryGateInput {
  status?: string;
  pullRequestUrl?: string;
  selfAttest?: InReviewSelfAttest;
}

export interface InReviewEntryGateError {
  error: string;
  details: { missing: string[] };
}

export function assertInReviewEntryGate(
  existing: { status: string },
  body: InReviewEntryGateInput,
): InReviewEntryGateError | null {
  if (body.status !== "in_review" || existing.status !== "in_progress") {
    return null;
  }
  const hasPullRequestUrl = typeof body.pullRequestUrl === "string" && body.pullRequestUrl.length > 0;
  const attest = body.selfAttest;
  const hasPassingAttest =
    !!attest &&
    attest.testsRun === true &&
    attest.docsUpdated === true &&
    attest.worktreeClean === true;
  if (hasPullRequestUrl || hasPassingAttest) {
    return null;
  }
  const missing: string[] = [];
  if (!hasPullRequestUrl) missing.push("pullRequestUrl");
  if (!attest || attest.testsRun !== true) missing.push("selfAttest.testsRun");
  if (!attest || attest.docsUpdated !== true) missing.push("selfAttest.docsUpdated");
  if (!attest || attest.worktreeClean !== true) missing.push("selfAttest.worktreeClean");
  return {
    error: "in_review entry requires a pullRequestUrl or a passing selfAttest checklist",
    details: { missing },
  };
}
