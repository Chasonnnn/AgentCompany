import type { CompanyUserDirectoryEntry } from "@/api/access";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";

export function buildCompanyUserInlineOptions(
  users: CompanyUserDirectoryEntry[] | null | undefined,
  opts: { excludeUserIds?: Array<string | null | undefined> } = {},
): InlineEntityOption[] {
  const excluded = new Set((opts.excludeUserIds ?? []).filter((id): id is string => Boolean(id)));
  return (users ?? [])
    .filter((entry) => entry.user?.id && !excluded.has(entry.user.id))
    .map((entry) => {
      const user = entry.user!;
      return {
        id: `user:${user.id}`,
        label: user.name || user.email || "User",
        searchText: `${user.name ?? ""} ${user.email ?? ""}`.trim(),
      };
    });
}
