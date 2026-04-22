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
    id: "single-owner-continuity",
    title: "Single-owner continuity",
    description: "An executing issue keeps one continuity owner while shared state lives in issue docs.",
    dimension: "reliability",
    layer: "invariant",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["continuity", "shared-state", "owner"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "continuity-docs",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-1/spec.md",
              content: "# Spec\n\n## Goal\n\nKeep one continuity owner for active execution.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-1/progress.md",
              content: "---\nkind: paperclip/issue-progress.v1\nsnapshot:\n  currentState: reviewer requested a follow-up pass\n  exactNextAction: update the implementation and resubmit to review\n  knownPitfalls:\n    - do not reassign the issue during review\n  openQuestions: []\n  evidenceLinks:\n    - tasks/platform/ISSUE-1/comments/heartbeat-1.md\ncheckpoints:\n  - timestamp: 2026-04-14T09:00:00.000Z\n    completed:\n      - initial implementation drafted\n    currentState: waiting on reviewer feedback\n    knownPitfalls:\n      - continuity must stay with the executor\n    exactNextAction: review feedback and plan the next patch\n    openQuestions: []\n    evidenceLinks:\n      - tasks/platform/ISSUE-1/comments/heartbeat-1.md\n---\n",
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
    id: "branch-and-merge-execution",
    title: "Branch-and-merge execution",
    description: "Bounded branch work returns artifacts to the parent continuity owner instead of relaying ownership.",
    dimension: "reliability",
    layer: "handoff",
    horizonBucket: "1_4h",
    canary: true,
    tags: ["branch", "merge", "continuity"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "branch-charter",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-2/spec.md",
              content: "# Spec\n\n## Goal\n\nParent issue owns the merged result.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-2/plan.md",
              content: "# Plan\n\n1. Open a bounded child issue for the spike.\n2. Merge returned findings into the parent issue docs.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-2/progress.md",
              content: "---\nkind: paperclip/issue-progress.v1\nsnapshot:\n  currentState: waiting on bounded branch spike\n  exactNextAction: merge the returned findings into the parent plan\n  knownPitfalls:\n    - branch workers cannot own the parent continuity\n  openQuestions: []\n  evidenceLinks:\n    - tasks/platform/ISSUE-2/branches/ISSUE-2A.md\ncheckpoints: []\n---\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-2A/branch-charter.md",
              content: "---\nkind: paperclip/issue-branch-charter.v1\npurpose: explore the risky implementation branch\nscope: prototype the risky change without taking parent ownership\nbudget: two focused work sessions\nexpectedReturnArtifact: a patch proposal and findings comment\nmergeCriteria:\n  - parent continuity owner accepts the result\n  - parent plan is updated with the decision\nexpiresAt: 2026-04-15T00:00:00.000Z\n---\n",
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
    id: "reviewer-as-negator",
    title: "Reviewer as negator",
    description: "A reviewer can block, annotate, and request changes without taking continuity ownership.",
    dimension: "reliability",
    layer: "role",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["review", "negation", "gate"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "review-gate",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-3/progress.md",
              content: "---\nkind: paperclip/issue-progress.v1\nsnapshot:\n  currentState: active review gate is open\n  exactNextAction: continuity owner addresses reviewer findings\n  knownPitfalls:\n    - reviewer must not rewrite the plan directly\n  openQuestions: []\n  evidenceLinks:\n    - tasks/platform/ISSUE-3/comments/review-findings.md\ncheckpoints: []\n---\n",
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
    id: "takeover-handoff-recovery",
    title: "Takeover and handoff recovery",
    description: "Owner reassignment, human takeover, and emergency override require a durable handoff artifact.",
    dimension: "reliability",
    layer: "workflow",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["handoff", "takeover", "recovery"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "handoff-recovery",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-4/handoff.md",
              content: "---\nkind: paperclip/issue-handoff.v1\nreasonCode: owner_stalled\ntransferTarget: agent:tech-lead-1\nunresolvedBranches:\n  - ISSUE-4A\nexactNextAction: resume the blocked merge and close the review loop\ntimestamp: 2026-04-14T10:15:00.000Z\n---\n",
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
    id: "role-pipeline-baseline-regression",
    title: "Role-pipeline baseline regression",
    description: "Compare the old role-relay baseline against shared-state execution and score drift.",
    dimension: "utility",
    layer: "portfolio",
    horizonBucket: "1_4h",
    canary: false,
    tags: ["baseline", "role-pipeline", "drift"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "baseline-comparison",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/status.md",
              content: "# Status\n\n- Compare shared-state continuity against the old role relay baseline.\n",
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
    id: "failure-promoted-hardening-scaffold",
    title: "Failure-promoted hardening scaffold",
    description: "Open typed review findings that expose reusable skill failures should promote into one hardening issue with scaffolded docs and explicit verification.",
    dimension: "reliability",
    layer: "workflow",
    horizonBucket: "15_60m",
    canary: true,
    tags: ["skill-hardening", "review-findings", "failure-promotion"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "failure-promoted-hardening",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-5/review-findings.md",
              content: "---\nkind: paperclip/issue-review-findings.v1\nreviewer: agent:qa-evals-1\ngateParticipant: agent:backend-api-1\nreviewStage: code_review\ndecisionContext: harden the reusable skill instead of patching one run\noutcome: changes_requested\nresolutionState: open\nownerNextAction: promote the reusable failure into a dedicated hardening issue and wire the verification plan\nfindings:\n  - findingId: finding-skill-001\n    severity: high\n    category: reusable-skill\n    title: Mirrored skill keeps emitting outdated follow-through steps\n    detail: The same instruction failure has now appeared in multiple review returns and should be repaired as reusable procedural memory.\n    requiredAction: create or refresh one durable hardening issue instead of burying the fix in comments\n    evidence:\n      - tasks/platform/ISSUE-5/comments/review-1.md\n    skillPromotion:\n      hardeningIssueId: issue-5a\n      hardeningIssueIdentifier: ISSUE-5A\n      companySkillId: company-skill-paperclip\n      companySkillKey: paperclip\n      sharedSkillId: shared-skill-paperclip\n      sourceRunId: run-review-5\n      failureFingerprint: fp-paperclip-review-finding-001\n      promotedAt: 2026-04-22T13:00:00.000Z\n      promotedBy: agent:qa-evals-1\n---\nFailure-promoted skill hardening keeps the recurrence-prevention lane explicit.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-5A/spec.md",
              content: "# Spec\n\n## Failure Source\n\n- Skill: `paperclip`\n- Failure fingerprint: `fp-paperclip-review-finding-001`\n- Source issue: `ISSUE-5`\n\n## Reproduction\n\nReview returns show the same mirrored-skill failure across more than one run.\n\n## Structural Fix\n\n- Repair the reusable skill path instead of applying a one-off patch.\n- Keep the hardening issue as the durable recurrence-prevention lane.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-5A/plan.md",
              content: "# Plan\n\n## Skill Hardening Steps\n\n1. Tighten the mirrored skill instructions and deterministic entrypoints.\n2. Keep the failure fingerprint attached to the hardening issue.\n3. Record exact eval coverage before asking for proposal approval.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-5A/test-plan.md",
              content: "# Test Plan\n\n## Promptfoo\n\n- `reliability.failure_promoted_hardening`\n- `reliability.shared_mirror_proposal_gate`\n\n## Architecture\n\n- `failure-promoted-hardening-scaffold`\n\n## Smoke\n\n- Confirm the review finding still points to the same hardening issue.\n",
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
    id: "failure-fingerprint-deduplication",
    title: "Failure fingerprint deduplication",
    description: "Repeated promotion of the same skill failure should refresh one hardening issue instead of opening duplicate recurrence lanes.",
    dimension: "reliability",
    layer: "invariant",
    horizonBucket: "15_60m",
    canary: false,
    tags: ["skill-hardening", "fingerprint", "dedupe"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "failure-fingerprint-dedupe",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-6/review-findings.md",
              content: "---\nkind: paperclip/issue-review-findings.v1\nreviewer: agent:qa-evals-1\ngateParticipant: agent:backend-api-1\nreviewStage: code_review\noutcome: changes_requested\nresolutionState: open\nownerNextAction: refresh the existing hardening issue instead of opening a duplicate\nfindings:\n  - findingId: finding-skill-002\n    severity: medium\n    category: reusable-skill\n    title: Repeat failure hit the same mirrored skill path again\n    detail: A second review return matched the same skill and failure fingerprint.\n    requiredAction: reuse the existing hardening lane and continue verification there\n    evidence:\n      - tasks/platform/ISSUE-6/comments/review-2.md\n    skillPromotion:\n      hardeningIssueId: issue-6a\n      hardeningIssueIdentifier: ISSUE-6A\n      companySkillId: company-skill-paperclip\n      companySkillKey: paperclip\n      sharedSkillId: shared-skill-paperclip\n      sourceRunId: run-review-6\n      failureFingerprint: fp-paperclip-review-finding-002\n      promotedAt: 2026-04-22T14:00:00.000Z\n      promotedBy: agent:qa-evals-1\n---\nRepeated review returns should converge on one hardening issue.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-6A/progress.md",
              content: "---\nkind: paperclip/issue-progress.v1\nsnapshot:\n  currentState: existing hardening issue refreshed after matching repeat failure\n  exactNextAction: continue verification on the reopened issue instead of creating another child lane\n  knownPitfalls:\n    - do not create a duplicate hardening issue when the failure fingerprint matches\n    - do not lose the prior verification history\n  openQuestions: []\n  evidenceLinks:\n    - tasks/platform/ISSUE-6/comments/review-2.md\n    - tasks/platform/ISSUE-6A/docs/test-plan.md\ncheckpoints: []\n---\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-6A/test-plan.md",
              content: "# Test Plan\n\n## Promptfoo\n\n- `reliability.failure_promoted_hardening`\n\n## Architecture\n\n- `failure-fingerprint-deduplication`\n\n## Smoke\n\n- Confirm repeated promotions still point to `ISSUE-6A`.\n",
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
    id: "scheduled-reliability-sweep-refresh",
    title: "Scheduled reliability sweep refresh",
    description: "A scheduled reliability sweep should refresh stale skill hardening work before a human trips over drift or a stale proposal.",
    dimension: "reliability",
    layer: "workflow",
    horizonBucket: "15_60m",
    canary: false,
    tags: ["skill-hardening", "scheduler", "stale-proposal"],
    fixture: {
      kind: "portable_company_package",
      basePackagePath: baseFixturePath,
      hermetic: true,
      externalDependencies: [],
      overlays: [
        {
          label: "scheduled-sweep-refresh",
          cleanup: "delete",
          files: [
            {
              path: "projects/platform/issues/ISSUE-7/spec.md",
              content: "# Spec\n\nA stale proposal should trigger refreshed hardening work during the scheduled reliability sweep.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-7/plan.md",
              content: "# Plan\n\n1. Run the reliability sweep in report_and_refresh mode.\n2. Reopen or refresh the hardening issue tied to the stale proposal.\n3. Keep the mirror read-only until verification is green.\n",
              mode: "replace",
            },
            {
              path: "projects/platform/issues/ISSUE-7/test-plan.md",
              content: "# Test Plan\n\n## Promptfoo\n\n- `reliability.shared_mirror_proposal_gate`\n\n## Architecture\n\n- `scheduled-reliability-sweep-refresh`\n\n## Smoke\n\n- Confirm the sweep refreshed hardening work before manual intervention.\n",
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
