export function collectLiveIssueIds(liveRuns: Array<{ issueId?: string | null }> | null | undefined) {
  const ids = new Set<string>();
  for (const run of liveRuns ?? []) {
    if (run.issueId) ids.add(run.issueId);
  }
  return ids;
}
