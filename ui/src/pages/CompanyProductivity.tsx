import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { companiesApi } from "../api/companies";
import {
  AgentProductivityTable,
  LowYieldRunList,
  ProductivityMetricGrid,
} from "../components/ProductivitySummaryPanel";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

type WindowKey = "7d" | "30d" | "all";

const WINDOWS: Array<{ key: WindowKey; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
];

export function CompanyProductivity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");

  useEffect(() => {
    setBreadcrumbs([{ label: "Company", href: "/company/settings" }, { label: "Productivity" }]);
  }, [setBreadcrumbs]);

  const productivityQuery = useQuery({
    queryKey: queryKeys.companies.productivity(selectedCompanyId ?? "__none__", windowKey),
    queryFn: () => companiesApi.productivity(selectedCompanyId!, windowKey),
    enabled: Boolean(selectedCompanyId),
  });

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company to view productivity.</p>;
  if (productivityQuery.isLoading && !productivityQuery.data) return <PageSkeleton variant="list" />;
  const summary = productivityQuery.data;
  if (!summary) return <p className="text-sm text-muted-foreground">Productivity data is unavailable.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Productivity</h2>
          <p className="text-sm text-muted-foreground">
            Advisory rollups from heartbeat liveness, token usage, completions, and continuation health.
          </p>
        </div>
        <div className="flex gap-1 rounded border border-border p-1">
          {WINDOWS.map((windowOption) => (
            <Button
              key={windowOption.key}
              type="button"
              size="sm"
              variant={windowKey === windowOption.key ? "default" : "ghost"}
              onClick={() => setWindowKey(windowOption.key)}
            >
              {windowOption.label}
            </Button>
          ))}
        </div>
      </div>

      <ProductivityMetricGrid totals={summary.totals} ratios={summary.ratios} />

      {summary.recommendations.length > 0 && (
        <section className="border border-border p-4">
          <h3 className="text-base font-medium">Recommendations</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {summary.recommendations.map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-base font-medium">Agents</h3>
        <AgentProductivityTable agents={summary.agents} />
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-medium">Recent Low-Yield Runs</h3>
        <LowYieldRunList runs={summary.lowYieldRuns} />
      </section>
    </div>
  );
}
