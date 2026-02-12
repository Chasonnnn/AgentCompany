export function shouldIncludeColleaguesForTick(tick, hasKnownColleagues) {
  if (!hasKnownColleagues) return true;
  return tick % 6 === 0;
}

export function mergeThinUiSnapshot({ monitor, inbox, fullUi, previousSnapshot }) {
  const prev = previousSnapshot ?? {};
  return {
    workspace_dir: fullUi?.workspace_dir ?? prev.workspace_dir ?? "",
    generated_at: fullUi?.generated_at ?? new Date().toISOString(),
    index_sync_worker:
      fullUi?.index_sync_worker ??
      prev.index_sync_worker ?? {
        enabled: false,
        pending_workspaces: 0
      },
    monitor,
    review_inbox: inbox,
    usage_analytics: fullUi?.usage_analytics ?? prev.usage_analytics ?? null,
    colleagues: fullUi?.colleagues ?? prev.colleagues ?? [],
    comments: fullUi?.comments ?? prev.comments ?? []
  };
}
