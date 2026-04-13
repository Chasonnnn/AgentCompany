import type { EvalBundle, EvalScenario } from "../../packages/shared/src/index.js";

const reliabilityFairness = {
  budgetCeilingUsd: 5,
  timeCeilingMinutes: 30,
  tools: ["paperclip-api", "git", "docs"],
  repoState: "clean-main",
  approvalPolicy: "default_governed",
  successCriteria: [
    "required artifacts present",
    "no scope violation",
    "routing follows the operating model",
  ],
} as const;

const stabilityFairness = {
  budgetCeilingUsd: 10,
  timeCeilingMinutes: 120,
  tools: ["paperclip-api", "git", "runtime-control"],
  repoState: "clean-main",
  approvalPolicy: "default_governed",
  successCriteria: [
    "resume cleanly after failure injection",
    "no duplicate work after restart",
    "state remains internally consistent",
  ],
} as const;

const utilityFairness = {
  budgetCeilingUsd: 8,
  timeCeilingMinutes: 60,
  tools: ["paperclip-api", "git", "docs"],
  repoState: "clean-main",
  approvalPolicy: "default_governed",
  successCriteria: [
    "required artifacts present",
    "accepted outcome",
    "bundle comparison uses identical scenario constraints",
  ],
} as const;

const baseFixturePath = "evals/fixtures/base-company";

export const SEEDED_EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "worker-isolation-across-projects",
    title: "Worker isolation across projects",
    description: "A worker cannot hold raw execution scope for two projects at once.",
    dimension: "reliability",
    layer: "invariant",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["scope", "governance", "invariant"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "two-projects",
          cleanup: "delete",
          files: [
            {
              path: "projects/runtime/PROJECT.md",
              content: "# Runtime\n\nSecondary project for worker-isolation scenarios.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: reliabilityFairness,
    timeoutPolicy: { maxMinutes: 30, idleMinutes: 5 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
  {
    id: "director-tech-lead-handoff-quality",
    title: "Director and tech-lead handoff quality",
    description: "Leadership handoffs should preserve routing clarity and decision context.",
    dimension: "reliability",
    layer: "handoff",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["handoff", "leadership", "routing"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "handoff-docs",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/decision-log.md",
              content: "# Decision Log\n\n- Handoff requested from Director to Tech Lead.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: reliabilityFairness,
    timeoutPolicy: { maxMinutes: 30, idleMinutes: 5 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
  {
    id: "consultant-engagement-gating",
    title: "Consultant engagement gating",
    description: "Dotted-line consulting only starts after an approved shared-service engagement.",
    dimension: "reliability",
    layer: "role",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["consulting", "governance", "shared-service"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "consulting-request",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/risks.md",
              content: "# Risks\n\n- External audit requested pending engagement approval.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: reliabilityFairness,
    timeoutPolicy: { maxMinutes: 30, idleMinutes: 5 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
  {
    id: "vp-portfolio-conflict-handling",
    title: "VP portfolio conflict handling",
    description: "Portfolio conflicts should escalate through leadership without bypassing project chains.",
    dimension: "reliability",
    layer: "role",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["portfolio", "prioritization", "leadership"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "portfolio-conflict",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/status.md",
              content: "# Status\n\n- Blocked by shared infra contention.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: reliabilityFairness,
    timeoutPolicy: { maxMinutes: 45, idleMinutes: 10 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
  {
    id: "conference-room-decision-to-approval",
    title: "Conference-room decision resolves into approval",
    description: "Leadership room decisions must resolve through the approval channel, not by comment alone.",
    dimension: "reliability",
    layer: "workflow",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["conference-room", "approval", "governance"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "approval-resolution",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/context.md",
              content: "# Context\n\nLeadership room requires governed approval for rollout.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: reliabilityFairness,
    timeoutPolicy: { maxMinutes: 30, idleMinutes: 5 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
  {
    id: "crash-restart-no-duplicate-work",
    title: "Crash and restart with no duplicate work",
    description: "Restarting the architecture should recover without reassigning or duplicating active work.",
    dimension: "stability",
    layer: "workflow",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["restart", "resume", "stability"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "restart-seed",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/runbook.md",
              content: "# Runbook\n\n- Restart and resume seed path.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: stabilityFairness,
    timeoutPolicy: { maxMinutes: 90, idleMinutes: 15 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: "restart_resume",
  },
  {
    id: "multi-project-overnight-soak-seed",
    title: "Multi-project overnight soak seed",
    description: "A seeded overnight soak should preserve coordination across concurrent projects.",
    dimension: "stability",
    layer: "soak",
    horizonBucket: "half_day",
    canary: false,
    tags: ["soak", "concurrency", "portfolio"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "overnight-soak",
          cleanup: "delete",
          files: [
            {
              path: "projects/runtime/status.md",
              content: "# Status\n\n- Overnight soak seed across multiple workstreams.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: stabilityFairness,
    timeoutPolicy: { maxMinutes: 360, idleMinutes: 30 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: "concurrency_heavy",
  },
  {
    id: "hierarchy-vs-flat-vs-single-agent",
    title: "Hierarchy vs flat pod vs single agent baseline seed",
    description: "Compare utility across bundle shapes while pinning the same fairness constraints.",
    dimension: "utility",
    layer: "portfolio",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["utility", "baseline", "ablation"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "bundle-comparison",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/status.md",
              content: "# Status\n\n- Bundle comparison seed.\n",
              mode: "replace",
            },
          ],
        },
      ],
    },
    fairnessConstraints: utilityFairness,
    timeoutPolicy: { maxMinutes: 60, idleMinutes: 10 },
    requiredArtifacts: ["manifest", "trace", "scorecard", "replay", "fixture-tree"],
    chaosProfile: null,
  },
];

export const SEEDED_EVAL_BUNDLES: EvalBundle[] = [
  {
    id: "architecture-canary",
    label: "Architecture Canary",
    description: "Small seeded canary set for PR-safe reliability checks.",
    lane: "canary",
    scenarioIds: SEEDED_EVAL_SCENARIOS.filter((scenario) => scenario.canary).map((scenario) => scenario.id),
    featureFlags: [],
    baselineKind: null,
    ablationKind: null,
  },
  {
    id: "architecture-nightly",
    label: "Architecture Nightly",
    description: "Full nightly reliability and seed matrix.",
    lane: "nightly",
    scenarioIds: SEEDED_EVAL_SCENARIOS.map((scenario) => scenario.id),
    featureFlags: [],
    baselineKind: null,
    ablationKind: null,
  },
  {
    id: "architecture-soak",
    label: "Architecture Soak",
    description: "Stability seeds for restart and concurrency-heavy runs.",
    lane: "soak",
    scenarioIds: SEEDED_EVAL_SCENARIOS
      .filter((scenario) => scenario.dimension === "stability")
      .map((scenario) => scenario.id),
    featureFlags: [],
    baselineKind: null,
    ablationKind: null,
  },
  {
    id: "baseline-single-strong-worker",
    label: "Single strong worker",
    description: "Utility baseline with no explicit hierarchy.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: "single_strong_worker",
    ablationKind: null,
  },
  {
    id: "baseline-flat-pod",
    label: "Flat pod",
    description: "Utility baseline with a flat pod structure.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: "flat_pod",
    ablationKind: null,
  },
  {
    id: "baseline-full-hierarchy",
    label: "Full hierarchy",
    description: "Utility baseline with the full company hierarchy.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: "full_hierarchy",
    ablationKind: null,
  },
  {
    id: "ablation-no-vp-layer",
    label: "Ablation: remove VP layer",
    description: "Utility ablation without the VP layer.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: null,
    ablationKind: "remove_vp_layer",
  },
  {
    id: "ablation-no-conference-rooms",
    label: "Ablation: remove conference-room coordination",
    description: "Utility ablation without conference-room routing.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: null,
    ablationKind: "remove_conference_rooms",
  },
  {
    id: "ablation-no-consultant-path",
    label: "Ablation: remove consultant path",
    description: "Utility ablation without shared-service consulting.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: null,
    ablationKind: "remove_consultant_path",
  },
  {
    id: "ablation-collapsed-leadership",
    label: "Ablation: collapse director and tech lead",
    description: "Utility ablation with a collapsed leadership layer.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: null,
    ablationKind: "collapse_director_and_tech_lead",
  },
  {
    id: "ablation-no-packets",
    label: "Ablation: remove packet conventions",
    description: "Utility ablation without the operating-model packet conventions.",
    lane: "baseline",
    scenarioIds: ["hierarchy-vs-flat-vs-single-agent"],
    featureFlags: [],
    baselineKind: null,
    ablationKind: "remove_packet_conventions",
  },
];

export function getScenarioById(id: string): EvalScenario {
  const scenario = SEEDED_EVAL_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown eval scenario '${id}'.`);
  }
  return scenario;
}

export function getBundlesForLane(lane: EvalBundle["lane"]): EvalBundle[] {
  return SEEDED_EVAL_BUNDLES.filter((bundle) => bundle.lane === lane);
}
