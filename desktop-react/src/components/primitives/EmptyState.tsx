export function EmptyState({ message, compact = false }: { message: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`.trim()}>{message}</div>;
}
