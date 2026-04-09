export function uniqueRunsByAgent<T extends { agentId: string }>(runs: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const run of runs) {
    if (seen.has(run.agentId)) continue;
    seen.add(run.agentId);
    unique.push(run);
  }

  return unique;
}
