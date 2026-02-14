import type { ProjectPMViewModel } from "@/types";
import { formatDateTime } from "@/utils/format";

type TaskBar = ProjectPMViewModel["gantt"]["tasks"][number];

function dayValue(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

export function Gantt({ gantt }: { gantt: ProjectPMViewModel["gantt"] }) {
  if (gantt.tasks.length === 0) {
    return <div className="empty-state">No scheduled tasks yet.</div>;
  }

  const byTeam = new Map<string, number>();
  for (const task of gantt.tasks) {
    const key = task.team_id ?? "unassigned";
    byTeam.set(key, (byTeam.get(key) ?? 0) + 1);
  }
  const teamLoad = [...byTeam.entries()].map(([team, count]) => ({
    team,
    count,
    pressure: count >= 6 ? "high" : count >= 3 ? "medium" : "low"
  }));
  const criticalCount = gantt.tasks.filter((task) => task.critical).length;
  const blockedCritical = gantt.tasks.filter((task) => task.critical && task.status === "blocked").length;

  const starts = gantt.tasks.map((task) => dayValue(task.start_at));
  const ends = gantt.tasks.map((task) => dayValue(task.end_at));
  const minDay = Math.min(...starts);
  const maxDay = Math.max(...ends);
  const spanDays = Math.max(1, maxDay - minDay + 1);
  const dayWidth = 26;
  const rowHeight = 30;
  const leftLabel = 220;
  const chartWidth = leftLabel + spanDays * dayWidth + 28;
  const chartHeight = gantt.tasks.length * rowHeight + 18;

  return (
    <div className="stack">
      <div className="hstack" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="badge">Critical path tasks: {criticalCount}</span>
        <span className={`badge ${blockedCritical > 0 ? "danger" : ""}`.trim()}>
          Blocked critical: {blockedCritical}
        </span>
        {teamLoad.map((row) => (
          <span
            key={row.team}
            className={`badge ${row.pressure === "high" ? "danger" : row.pressure === "medium" ? "warn" : ""}`.trim()}
          >
            {row.team}: {row.count}
          </span>
        ))}
      </div>

      {gantt.cpm_status === "dependency_cycle" ? (
        <div className="empty-state">
          <span className="error">Dependency cycle detected.</span> Schedule bars are shown with best effort.
        </div>
      ) : null}

      <div className="gantt-scroll">
        <svg width={chartWidth} height={chartHeight} role="img" aria-label="Project schedule">
          {gantt.tasks.map((task, index) => (
            <TaskRow
              key={task.task_id}
              task={task}
              index={index}
              minDay={minDay}
              dayWidth={dayWidth}
              rowHeight={rowHeight}
              leftLabel={leftLabel}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  index,
  minDay,
  dayWidth,
  rowHeight,
  leftLabel
}: {
  task: TaskBar;
  index: number;
  minDay: number;
  dayWidth: number;
  rowHeight: number;
  leftLabel: number;
}) {
  const startOffset = dayValue(task.start_at) - minDay;
  const endOffset = Math.max(startOffset + 1, dayValue(task.end_at) - minDay);
  const barX = leftLabel + startOffset * dayWidth;
  const barW = Math.max(6, (endOffset - startOffset) * dayWidth);
  const y = 8 + index * rowHeight;
  return (
    <g transform={`translate(0 ${y})`}>
      <text x={8} y={14} fontSize={11} fill="#2e3b4e">
        {task.title.slice(0, 34)}
      </text>
      <rect x={barX} y={3} width={barW} height={14} rx={7} fill={task.critical ? "#0a64e8" : "#7f8fa5"} />
      {task.critical ? <circle cx={barX + barW + 7} cy={10} r={3} fill="#0a64e8" /> : null}
      <text x={barX} y={28} fontSize={10} fill="#6a7788">
        {formatDateTime(task.start_at)}
      </text>
    </g>
  );
}
