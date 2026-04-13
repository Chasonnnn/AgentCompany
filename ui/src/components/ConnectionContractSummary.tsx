import { type ConnectionContract } from "@paperclipai/shared";

function ContractList({
  title,
  values,
}: {
  title: string;
  values: string[];
}) {
  if (values.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
      <ul className="list-disc space-y-1 pl-4 text-sm text-foreground/90">
        {values.map((value) => (
          <li key={`${title}:${value}`}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

export function ConnectionContractSummary({
  contract,
}: {
  contract: ConnectionContract;
}) {
  const cadence = Object.entries(contract.cadence ?? {}).filter(([, value]) => typeof value === "string" && value.trim().length > 0);

  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-4 space-y-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Connection Contract</h4>
        <p className="text-xs text-muted-foreground">
          Read-only summary parsed from AGENTS frontmatter.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ContractList title="Upstream Inputs" values={contract.upstreamInputs} />
        <ContractList title="Downstream Outputs" values={contract.downstreamOutputs} />
        <ContractList title="Owned Artifacts" values={contract.ownedArtifacts} />
        <ContractList title="Delegation Rights" values={contract.delegationRights} />
        <ContractList title="Review Rights" values={contract.reviewRights} />
        <ContractList title="Escalation Path" values={contract.escalationPath} />
        <ContractList title="Standing Rooms" values={contract.standingRooms} />
        <ContractList title="Scope Boundaries" values={contract.scopeBoundaries} />
      </div>
      {cadence.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Cadence</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {cadence.map(([key, value]) => (
              <div key={key} className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-sm">
                <span className="font-medium">{key}</span>
                <span className="text-muted-foreground">: {value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
