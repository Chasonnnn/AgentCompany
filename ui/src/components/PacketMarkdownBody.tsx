import {
  describePacketEnvelope,
  parsePacketEnvelopeMarkdown,
  type PacketEnvelope,
} from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";

function renderList(title: string, values: string[]) {
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

function PacketFields({ envelope }: { envelope: PacketEnvelope }) {
  switch (envelope.kind) {
    case "paperclip/assignment.v1":
      return (
        <div className="space-y-3">
          {envelope.owner ? <p className="text-sm"><span className="font-medium">Owner:</span> {envelope.owner}</p> : null}
          {envelope.requestedBy ? <p className="text-sm"><span className="font-medium">Requested by:</span> {envelope.requestedBy}</p> : null}
          {envelope.objective ? <p className="text-sm"><span className="font-medium">Objective:</span> {envelope.objective}</p> : null}
          {envelope.scope ? <p className="text-sm"><span className="font-medium">Scope:</span> {envelope.scope}</p> : null}
          {renderList("Definition of Done", envelope.definitionOfDone ?? [])}
          {renderList("Dependencies", envelope.dependencies ?? [])}
          {renderList("Non-goals", envelope.nonGoals ?? [])}
          {renderList("Escalate If", envelope.escalateIf ?? [])}
        </div>
      );
    case "paperclip/heartbeat.v1":
      return (
        <div className="space-y-3">
          {envelope.state ? (
            <p className="text-sm">
              <span className="font-medium">State:</span> {envelope.state}
            </p>
          ) : null}
          {envelope.progress ? <p className="text-sm"><span className="font-medium">Progress:</span> {envelope.progress}</p> : null}
          {renderList("Completed", envelope.completedSinceLastUpdate ?? [])}
          {renderList("Next Actions", envelope.nextActions ?? [])}
          {renderList("Blockers", envelope.blockers ?? [])}
          {renderList("Need From Manager", envelope.needFromManager ?? [])}
          {renderList("Artifacts Updated", envelope.artifactsUpdated ?? [])}
        </div>
      );
    case "paperclip/decision-request.v1":
      return (
        <div className="space-y-3">
          {envelope.decisionNeeded ? <p className="text-sm"><span className="font-medium">Decision needed:</span> {envelope.decisionNeeded}</p> : null}
          {envelope.recommendedOption ? <p className="text-sm"><span className="font-medium">Recommended:</span> {envelope.recommendedOption}</p> : null}
          {envelope.whyNow ? <p className="text-sm"><span className="font-medium">Why now:</span> {envelope.whyNow}</p> : null}
          {renderList("Options Considered", envelope.optionsConsidered ?? [])}
          {renderList("Tradeoffs", envelope.tradeoffs ?? [])}
          {renderList("References", envelope.references ?? [])}
        </div>
      );
    case "paperclip/review-request.v1":
      return (
        <div className="space-y-3">
          {envelope.reviewType ? <p className="text-sm"><span className="font-medium">Review type:</span> {envelope.reviewType}</p> : null}
          {envelope.scope ? <p className="text-sm"><span className="font-medium">Scope:</span> {envelope.scope}</p> : null}
          {envelope.deadline ? <p className="text-sm"><span className="font-medium">Deadline:</span> {envelope.deadline}</p> : null}
          {renderList("Acceptance Criteria", envelope.acceptanceCriteria ?? [])}
          {renderList("Specific Questions", envelope.specificQuestions ?? [])}
          {renderList("Artifacts", envelope.artifacts ?? [])}
        </div>
      );
    case "paperclip/escalation.v1":
      return (
        <div className="space-y-3">
          {envelope.problem ? <p className="text-sm"><span className="font-medium">Problem:</span> {envelope.problem}</p> : null}
          {envelope.currentOwner ? <p className="text-sm"><span className="font-medium">Current owner:</span> {envelope.currentOwner}</p> : null}
          {envelope.whyBlocked ? <p className="text-sm"><span className="font-medium">Why blocked:</span> {envelope.whyBlocked}</p> : null}
          {envelope.neededDecisionOrResource ? (
            <p className="text-sm"><span className="font-medium">Needed:</span> {envelope.neededDecisionOrResource}</p>
          ) : null}
          {renderList("Attempted", envelope.attempted ?? [])}
          {renderList("Affected Parties", envelope.affectedParties ?? [])}
        </div>
      );
  }
}

export function PacketMarkdownBody({
  markdown,
  className,
  recessed = false,
  onImageClick,
}: {
  markdown: string;
  className?: string;
  recessed?: boolean;
  onImageClick?: (src: string) => void;
}) {
  const parsed = parsePacketEnvelopeMarkdown(markdown);
  if (!parsed) {
    return (
      <MarkdownBody
        className={className}
        style={recessed ? { opacity: 0.55 } : undefined}
        softBreaks
        onImageClick={onImageClick}
      >
        {markdown}
      </MarkdownBody>
    );
  }

  const description = describePacketEnvelope(parsed.envelope);

  return (
    <div className={cn("space-y-3", className)}>
      <div className={cn(
        "rounded-lg border border-border/70 bg-muted/30 px-3 py-3",
        recessed && "opacity-70",
      )}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {description.label}
          </span>
          <span className="text-sm font-medium">{description.summary}</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Non-authoritative packet. State changes still require the underlying issue, approval, room, or engagement action.
        </p>
        <div className="mt-3">
          <PacketFields envelope={parsed.envelope} />
        </div>
      </div>
      {parsed.body ? (
        <MarkdownBody
          className={className}
          style={recessed ? { opacity: 0.55 } : undefined}
          softBreaks
          onImageClick={onImageClick}
        >
          {parsed.body}
        </MarkdownBody>
      ) : null}
    </div>
  );
}
