import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { companySkillsApi } from "../api/companySkills";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { agentTemplatesApi } from "../api/agentTemplates";
import { budgetsApi } from "../api/budgets";
import { conferenceRoomsApi } from "../api/conferenceRooms";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import {
  createCreateValuesForAdapterType,
  defaultCreateValues,
} from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId
} from "../lib/onboarding-launch";
import {
  buildGlobalCatalogInstallPlan,
  buildCompanyDocumentBody,
  buildEngineeringTeamDocumentBody,
  buildFallbackCompanyGoal,
  buildMarketingTeamDocumentBody,
  buildOnboardingKickoffQuestion,
  buildOnboardingProjectDocuments,
  buildOnboardingProjectGoal,
  canonicalizeDesiredSkillRefs,
  mergeDesiredSkillRefs,
  buildOperationsTeamDocumentBody,
  buildResearchTeamDocumentBody,
  DEFAULT_COMPANY_BUDGET_CENTS,
  DEFAULT_OFFICE_OPERATOR_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_ONBOARDING_PROJECT_BUDGET_CENTS,
  DEFAULT_STARTER_AGENT_BUDGET_CENTS,
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_SEC,
  ONBOARDING_BRANCH_TITLE,
  ONBOARDING_COMPANY_SKILL_IMPORT_SLUGS,
  ONBOARDING_DEMO_TITLES,
  ONBOARDING_KICKOFF_ROOM_TITLE,
  ONBOARDING_REQUIRED_STARTER_SKILL_SLUGS,
  ONBOARDING_ROUTINE_TITLES,
  ONBOARDING_STARTER_SKILL_ASSIGNMENTS,
  STARTER_BACKEND_CONTINUITY_OWNER_NAMES,
  STARTER_AGENT_NAMES,
  STARTER_QA_EVALS_CONTINUITY_OWNER_NAMES,
} from "../lib/onboarding-bootstrap";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import {
  defaultCodexLocalFastModeForModel,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import {
  Building2,
  Bot,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ChevronDown,
  X
} from "lucide-react";


type Step = 1 | 2 | 3 | 4;
type AdapterType = string;

const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- route company-wide coordination through the Chief of Staff
- keep the project lead focused on the first execution lane
- break the first milestone into concrete continuity-owned work`;

function findTemplateIdByArchetype(templates: Array<{ id: string; archetypeKey: string }>, archetypeKey: string) {
  return templates.find((template) => template.archetypeKey === archetypeKey)?.id ?? null;
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const [routeDismissed, setRouteDismissed] = useState(false);

  // Sync disabled adapter types from server so adapter grid filters them out
  const disabledTypes = useDisabledAdaptersSync();

  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  const initialStep = effectiveOnboardingOptions.initialStep ?? 1;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");

  // Step 2
  const [agentName, setAgentName] = useState("CEO");
  const [adapterType, setAdapterType] = useState<AdapterType>("claude_local");
  const [model, setModel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);

  // Step 3
  const [taskTitle, setTaskTitle] = useState(
    "Set up the first lean execution lane"
  );
  const [taskDescription, setTaskDescription] = useState(
    DEFAULT_TASK_DESCRIPTION
  );

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >(null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    null
  );
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Sync step and company when onboarding opens with options.
  // Keep this independent from company-list refreshes so Step 1 completion
  // doesn't get reset after creating a company.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.companyId ?? null;
    setStep(effectiveOnboardingOptions.initialStep ?? 1);
    setCreatedCompanyId(cId);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedAgentId(null);
    setCreatedIssueRef(null);
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.companyId,
    effectiveOnboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Resize textarea when step 3 is shown or description changes
  useEffect(() => {
    if (step === 3) autoResizeTextarea();
  }, [step, taskDescription, autoResizeTextarea]);

  const { data: adapterModels } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Paperclip host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapter = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;

  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);
    const all = listUIAdapters()
      .filter((a) =>
        !SYSTEM_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);
  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));

  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setAgentName("CEO");
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setTaskTitle("Set up the first lean execution lane");
    setTaskDescription(DEFAULT_TASK_DESCRIPTION);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedAgentId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
  }

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...createCreateValuesForAdapterType(adapterType),
      model:
        adapterType === "codex_local"
          ? model || DEFAULT_CODEX_LOCAL_MODEL
          : adapterType === "gemini_local"
            ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox,
      fastMode:
        adapterType === "codex_local"
          ? defaultCodexLocalFastModeForModel(model || DEFAULT_CODEX_LOCAL_MODEL)
          : defaultCreateValues.fastMode,
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }

  async function ensureCompanySkillSlugs(
    companyId: string,
    desiredSlugs: string[],
    options?: { requiredSlugs?: string[] },
  ) {
    const [installedSkills, globalCatalog] = await Promise.all([
      companySkillsApi.list(companyId),
      companySkillsApi.globalCatalog(companyId),
    ]);
    const installedSlugSet = new Set(installedSkills.map((skill) => skill.slug));
    const { installCatalogKeys, missingSlugs } = buildGlobalCatalogInstallPlan(
      installedSlugSet,
      globalCatalog,
      desiredSlugs,
    );

    for (const catalogKey of installCatalogKeys) {
      await companySkillsApi.installGlobal(companyId, { catalogKey });
    }

    const refreshedSkills = installCatalogKeys.length > 0
      ? await companySkillsApi.list(companyId)
      : installedSkills;
    const refreshedSlugSet = new Set(refreshedSkills.map((skill) => skill.slug));
    const requiredSlugs = Array.from(new Set(options?.requiredSlugs ?? desiredSlugs));
    const stillMissingRequired = requiredSlugs.filter((slug) => !refreshedSlugSet.has(slug));
    if (stillMissingRequired.length > 0) {
      throw new Error(
        `Missing required company skills: ${stillMissingRequired.join(", ")}`,
      );
    }

    if (missingSlugs.length > 0) {
      console.warn("Skipped missing catalog skills during onboarding bootstrap:", missingSlugs);
    }

    return refreshedSkills;
  }

  async function ensureAgentDesiredSkills(
    companyId: string,
    agentId: string,
    desiredRefs: string[],
    slugToKey: Map<string, string>,
  ) {
    const snapshot = await agentsApi.skills(agentId, companyId);
    const currentRefs = canonicalizeDesiredSkillRefs(snapshot.desiredSkills, slugToKey);
    const nextRefs = canonicalizeDesiredSkillRefs(
      mergeDesiredSkillRefs(snapshot.desiredSkills, desiredRefs),
      slugToKey,
    );
    if (arraysEqual(currentRefs, nextRefs)) return;
    await agentsApi.syncSkills(agentId, nextRefs, companyId);
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const trimmedCompanyName = companyName.trim();
      const company = await companiesApi.create({
        name: trimmedCompanyName,
        budgetMonthlyCents: DEFAULT_COMPANY_BUDGET_CENTS,
      });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      const parsedGoal = companyGoal.trim()
        ? parseOnboardingGoalInput(companyGoal)
        : buildFallbackCompanyGoal(trimmedCompanyName);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description ? { description: parsedGoal.description } : {}),
        level: "company",
        status: "active",
      });
      setCreatedCompanyGoalId(goal.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2Next() {
    if (!createdCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        if (!isValidOpenCodeModelId(model)) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
      }

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      await ensureCompanySkillSlugs(
        createdCompanyId,
        ONBOARDING_STARTER_SKILL_ASSIGNMENTS.ceo,
        { requiredSlugs: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.ceo },
      );

      const agent = await agentsApi.create(createdCompanyId, {
        name: agentName.trim(),
        role: "ceo",
        departmentKey: "executive",
        desiredSkills: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.ceo,
        adapterType,
        adapterConfig: buildAdapterConfig(),
        runtimeConfig: buildNewAgentRuntimeConfig(),
        budgetMonthlyCents: DEFAULT_STARTER_AGENT_BUDGET_CENTS,
      });
      setCreatedAgentId(agent.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setError(null);
    setStep(4);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      const companyId = createdCompanyId;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const currentCompany = await companiesApi.get(companyId);
      const resolvedCompanyName = currentCompany.name;

      if ((currentCompany.budgetMonthlyCents ?? 0) <= 0) {
        await companiesApi.update(companyId, { budgetMonthlyCents: DEFAULT_COMPANY_BUDGET_CENTS });
      }

      let allGoals = await goalsApi.list(companyId);
      let companyGoalId = createdCompanyGoalId ?? selectDefaultCompanyGoalId(allGoals);
      let companyGoal = companyGoalId
        ? allGoals.find((goal) => goal.id === companyGoalId) ?? null
        : null;
      if (!companyGoal) {
        const fallbackGoal = buildFallbackCompanyGoal(resolvedCompanyName);
        companyGoal = await goalsApi.create(companyId, {
          title: fallbackGoal.title,
          description: fallbackGoal.description,
          level: "company",
          status: "active",
        });
        companyGoalId = companyGoal.id;
        setCreatedCompanyGoalId(companyGoal.id);
        allGoals = await goalsApi.list(companyId);
      }

      const onboardingProjectGoalDraft = buildOnboardingProjectGoal({
        companyName: resolvedCompanyName,
        companyGoalTitle: companyGoal.title,
        ownerAgentId: createdAgentId,
        parentId: companyGoal.id,
      });
      let onboardingProjectGoal =
        allGoals.find((goal) => goal.title === onboardingProjectGoalDraft.title)
        ?? await goalsApi.create(companyId, onboardingProjectGoalDraft);
      if (!allGoals.some((goal) => goal.id === onboardingProjectGoal.id)) {
        allGoals = await goalsApi.list(companyId);
      }

      let project = createdProjectId
        ? await projectsApi.get(createdProjectId, companyId).catch(() => null)
        : null;
      if (!project) {
        const existingProjects = await projectsApi.list(companyId);
        project = existingProjects.find((entry) => entry.name === "Onboarding") ?? null;
      }
      if (!project) {
        project = await projectsApi.create(
          companyId,
          buildOnboardingProjectPayload(onboardingProjectGoal.id, createdAgentId),
        );
        setCreatedProjectId(project.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.list(companyId)
        });
      }

      await budgetsApi.upsertPolicy(companyId, {
        scopeType: "project",
        scopeId: project.id,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: DEFAULT_ONBOARDING_PROJECT_BUDGET_CENTS,
      });

      const companySkills = await ensureCompanySkillSlugs(
        companyId,
        ONBOARDING_COMPANY_SKILL_IMPORT_SLUGS,
        { requiredSlugs: ONBOARDING_REQUIRED_STARTER_SKILL_SLUGS },
      );
      const skillKeyBySlug = new Map(companySkills.map((skill) => [skill.slug, skill.key] as const));

      const templates = await agentTemplatesApi.list(companyId);
      const officeOperatorTemplateId = findTemplateIdByArchetype(templates, "chief_of_staff");
      const technicalProjectLeadTemplateId = findTemplateIdByArchetype(templates, "project_lead");
      const backendContinuityOwnerTemplateId = findTemplateIdByArchetype(templates, "backend_api_continuity_owner");
      const qaEvalsContinuityOwnerTemplateId = findTemplateIdByArchetype(templates, "qa_evals_continuity_owner");
      if (
        !officeOperatorTemplateId ||
        !technicalProjectLeadTemplateId ||
        !backendContinuityOwnerTemplateId ||
        !qaEvalsContinuityOwnerTemplateId
      ) {
        throw new Error("Required onboarding agent templates are missing.");
      }

      const existingAgents = await agentsApi.list(companyId);
      const ceo = existingAgents.find((agent) => agent.id === createdAgentId)
        ?? existingAgents.find((agent) => agent.name === STARTER_AGENT_NAMES.ceo)
        ?? null;
      if (!ceo) {
        throw new Error("Starter CEO agent not found.");
      }
      if ((ceo.budgetMonthlyCents ?? 0) !== DEFAULT_STARTER_AGENT_BUDGET_CENTS) {
        await agentsApi.update(ceo.id, {
          budgetMonthlyCents: DEFAULT_STARTER_AGENT_BUDGET_CENTS,
        }, companyId);
      }

      const workerRuntimeConfig = buildNewAgentRuntimeConfig({
        heartbeatEnabled: true,
        intervalSec: DEFAULT_WORKER_HEARTBEAT_INTERVAL_SEC,
      });
      const officeRuntimeConfig = buildNewAgentRuntimeConfig({
        heartbeatEnabled: true,
        intervalSec: DEFAULT_OFFICE_OPERATOR_HEARTBEAT_INTERVAL_SEC,
      });

      async function ensureStarterAgent(input: {
        templateId: string;
        name: string;
        title: string;
        departmentKey: "engineering" | "operations" | "research" | "marketing";
        reportsTo: string | null;
        archetypeKey: string;
        desiredSkills: string[];
        runtimeConfig?: Record<string, unknown>;
        budgetMonthlyCents?: number;
        projectPlacement?: Record<string, unknown>;
        matchByArchetype?: boolean;
      }) {
        const existingByName = existingAgents.find((agent) => agent.name === input.name);
        const existingByArchetype = input.matchByArchetype === false
          ? null
          : existingAgents.find((agent) => agent.archetypeKey === input.archetypeKey);
        const existing = existingByName ?? existingByArchetype ?? null;
        const desiredBudgetMonthlyCents = input.budgetMonthlyCents ?? DEFAULT_STARTER_AGENT_BUDGET_CENTS;
        if (existing) {
          const desiredRuntimeConfig = input.runtimeConfig ?? {};
          const shouldUpdateRuntimeConfig =
            Object.keys(desiredRuntimeConfig).length > 0
            && JSON.stringify(existing.runtimeConfig ?? {}) !== JSON.stringify(desiredRuntimeConfig);
          const shouldUpdateBudget = (existing.budgetMonthlyCents ?? 0) !== desiredBudgetMonthlyCents;
          if (shouldUpdateRuntimeConfig || shouldUpdateBudget) {
            await agentsApi.update(existing.id, {
              ...(shouldUpdateRuntimeConfig ? { runtimeConfig: desiredRuntimeConfig } : {}),
              budgetMonthlyCents: desiredBudgetMonthlyCents,
            }, companyId);
          }
          return existing;
        }
        const created = await agentsApi.create(companyId, {
          name: input.name,
          title: input.title,
          templateId: input.templateId,
          reportsTo: input.reportsTo,
          departmentKey: input.departmentKey,
          desiredSkills: input.desiredSkills,
          adapterType,
          adapterConfig: buildAdapterConfig(),
          runtimeConfig: input.runtimeConfig ?? {},
          budgetMonthlyCents: desiredBudgetMonthlyCents,
          ...(input.projectPlacement ? { projectPlacement: input.projectPlacement } : {}),
        });
        existingAgents.push(created);
        return created;
      }

      const officeOperator = await ensureStarterAgent({
        templateId: officeOperatorTemplateId,
        name: STARTER_AGENT_NAMES.officeOperator,
        title: STARTER_AGENT_NAMES.officeOperator,
        departmentKey: "operations",
        reportsTo: ceo.id,
        archetypeKey: "chief_of_staff",
        desiredSkills: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.officeOperator,
        runtimeConfig: officeRuntimeConfig,
      });

      const technicalProjectLead = await ensureStarterAgent({
        templateId: technicalProjectLeadTemplateId,
        name: STARTER_AGENT_NAMES.technicalProjectLead,
        title: STARTER_AGENT_NAMES.technicalProjectLead,
        departmentKey: "engineering",
        reportsTo: officeOperator.id,
        archetypeKey: "project_lead",
        desiredSkills: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.technicalProjectLead,
        runtimeConfig: workerRuntimeConfig,
        projectPlacement: {
          projectId: project.id,
          projectRole: "engineering_manager",
          scopeMode: "leadership_raw",
          teamFunctionKey: "engineering",
          teamFunctionLabel: "Engineering",
          workstreamKey: "onboarding",
          workstreamLabel: "Onboarding bootstrap",
          requestedReason: "Onboarding starter team",
        },
      });

      const backendContinuityOwners: typeof existingAgents = [];
      for (const [index, name] of STARTER_BACKEND_CONTINUITY_OWNER_NAMES.entries()) {
        backendContinuityOwners.push(await ensureStarterAgent({
          templateId: backendContinuityOwnerTemplateId,
          name,
          title: name,
          departmentKey: "engineering",
          reportsTo: technicalProjectLead.id,
          archetypeKey: "backend_api_continuity_owner",
          desiredSkills: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.backendContinuityOwner,
          runtimeConfig: workerRuntimeConfig,
          projectPlacement: {
            projectId: project.id,
            projectRole: "worker",
            scopeMode: "execution",
            teamFunctionKey: "engineering",
            teamFunctionLabel: "Engineering",
            workstreamKey: "onboarding",
            workstreamLabel: "Onboarding bootstrap",
            requestedReason: "Onboarding starter team",
          },
          matchByArchetype: index === 0,
        }));
      }

      const qaEvalsContinuityOwners: typeof existingAgents = [];
      for (const [index, name] of STARTER_QA_EVALS_CONTINUITY_OWNER_NAMES.entries()) {
        qaEvalsContinuityOwners.push(await ensureStarterAgent({
          templateId: qaEvalsContinuityOwnerTemplateId,
          name,
          title: name,
          departmentKey: "operations",
          reportsTo: technicalProjectLead.id,
          archetypeKey: "qa_evals_continuity_owner",
          desiredSkills: ONBOARDING_STARTER_SKILL_ASSIGNMENTS.qaEvalsContinuityOwner,
          runtimeConfig: workerRuntimeConfig,
          projectPlacement: {
            projectId: project.id,
            projectRole: "worker",
            scopeMode: "execution",
            teamFunctionKey: "operations",
            teamFunctionLabel: "Operations",
            workstreamKey: "onboarding",
            workstreamLabel: "Onboarding bootstrap",
            requestedReason: "Onboarding starter team",
          },
          matchByArchetype: index === 0,
        }));
      }

      const primaryBackendContinuityOwner = backendContinuityOwners[0];
      const primaryQaEvalsContinuityOwner = qaEvalsContinuityOwners[0];
      if (!primaryBackendContinuityOwner || !primaryQaEvalsContinuityOwner) {
        throw new Error("Starter continuity owners could not be created.");
      }

      await ensureAgentDesiredSkills(
        companyId,
        ceo.id,
        ONBOARDING_STARTER_SKILL_ASSIGNMENTS.ceo,
        skillKeyBySlug,
      );
      await ensureAgentDesiredSkills(
        companyId,
        officeOperator.id,
        ONBOARDING_STARTER_SKILL_ASSIGNMENTS.officeOperator,
        skillKeyBySlug,
      );
      await ensureAgentDesiredSkills(
        companyId,
        technicalProjectLead.id,
        ONBOARDING_STARTER_SKILL_ASSIGNMENTS.technicalProjectLead,
        skillKeyBySlug,
      );
      for (const backendContinuityOwner of backendContinuityOwners) {
        await ensureAgentDesiredSkills(
          companyId,
          backendContinuityOwner.id,
          ONBOARDING_STARTER_SKILL_ASSIGNMENTS.backendContinuityOwner,
          skillKeyBySlug,
        );
      }
      for (const qaEvalsContinuityOwner of qaEvalsContinuityOwners) {
        await ensureAgentDesiredSkills(
          companyId,
          qaEvalsContinuityOwner.id,
          ONBOARDING_STARTER_SKILL_ASSIGNMENTS.qaEvalsContinuityOwner,
          skillKeyBySlug,
        );
      }

      const projectNeedsLeadUpdate =
        project.leadAgentId !== technicalProjectLead.id
        || !project.goalIds.includes(onboardingProjectGoal.id);
      if (projectNeedsLeadUpdate) {
        project = await projectsApi.update(project.id, {
          leadAgentId: technicalProjectLead.id,
          goalIds: project.goalIds.includes(onboardingProjectGoal.id)
            ? project.goalIds
            : [...project.goalIds, onboardingProjectGoal.id],
        }, companyId);
      }

      const companyDocuments = await companiesApi.listDocuments(companyId);
      if (!companyDocuments.some((document) => document.key === "company")) {
        await companiesApi.upsertDocument(companyId, "company", {
          title: "COMPANY.md",
          format: "markdown",
          body: buildCompanyDocumentBody({
            companyName: resolvedCompanyName,
            companyGoalTitle: companyGoal.title,
          }),
          baseRevisionId: null,
        });
      }

      const teamDocuments = await companiesApi.listTeamDocuments(companyId);
      const engineeringTeamDoc = teamDocuments.find((document) => document.departmentKey === "engineering" && document.key === "team");
      if (!engineeringTeamDoc) {
        await companiesApi.upsertTeamDocument(companyId, "engineering", "team", {
          title: "TEAM.md",
          format: "markdown",
          body: buildEngineeringTeamDocumentBody(),
          baseRevisionId: null,
        });
      }
      const operationsTeamDoc = teamDocuments.find((document) => document.departmentKey === "operations" && document.key === "team");
      if (!operationsTeamDoc) {
        await companiesApi.upsertTeamDocument(companyId, "operations", "team", {
          title: "TEAM.md",
          format: "markdown",
          body: buildOperationsTeamDocumentBody(),
          baseRevisionId: null,
        });
      }
      const researchTeamDoc = teamDocuments.find((document) => document.departmentKey === "research" && document.key === "team");
      if (!researchTeamDoc) {
        await companiesApi.upsertTeamDocument(companyId, "research", "team", {
          title: "TEAM.md",
          format: "markdown",
          body: buildResearchTeamDocumentBody(),
          baseRevisionId: null,
        });
      }
      const marketingTeamDoc = teamDocuments.find((document) => document.departmentKey === "marketing" && document.key === "team");
      if (!marketingTeamDoc) {
        await companiesApi.upsertTeamDocument(companyId, "marketing", "team", {
          title: "TEAM.md",
          format: "markdown",
          body: buildMarketingTeamDocumentBody(),
          baseRevisionId: null,
        });
      }

      const projectDocs = await projectsApi.listDocuments(project.id, companyId);
      const projectDocBodies = buildOnboardingProjectDocuments({
        companyName: resolvedCompanyName,
        companyGoalTitle: companyGoal.title,
        projectGoalTitle: onboardingProjectGoal.title,
      });
      for (const [key, body] of Object.entries(projectDocBodies)) {
        if (projectDocs.some((document) => document.key === key)) continue;
        await projectsApi.upsertDocument(project.id, key, {
          title: key === "decision-log" ? "Decision Log" : key,
          format: "markdown",
          body,
          baseRevisionId: null,
        }, companyId);
      }

      const routines = await routinesApi.list(companyId);
      const ensureRoutine = async (input: {
        title: string;
        description: string;
        assigneeAgentId: string;
        cronExpression: string;
        label: string;
      }) => {
        if (routines.some((routine) => routine.title === input.title)) return;
        const routine = await routinesApi.create(companyId, {
          projectId: project.id,
          goalId: onboardingProjectGoal.id,
          title: input.title,
          description: input.description,
          assigneeAgentId: input.assigneeAgentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "skip_if_active",
          catchUpPolicy: "skip_missed",
        });
        await routinesApi.createTrigger(routine.id, {
          kind: "schedule",
          label: input.label,
          enabled: true,
          cronExpression: input.cronExpression,
          timezone,
        });
      };

      await ensureRoutine({
        title: ONBOARDING_ROUTINE_TITLES.dailyReadiness,
        description: "Review onboarding readiness, open questions, and next actions for the governed bootstrap lane.",
        assigneeAgentId: officeOperator.id,
        cronExpression: "0 9 * * 1-5",
        label: "Weekdays at 9:00",
      });
      await ensureRoutine({
        title: ONBOARDING_ROUTINE_TITLES.weeklyBudgetAudit,
        description: "Audit budget posture, heartbeat defaults, and runtime health for the onboarding starter team.",
        assigneeAgentId: primaryQaEvalsContinuityOwner.id,
        cronExpression: "0 10 * * 1",
        label: "Mondays at 10:00",
      });
      await ensureRoutine({
        title: ONBOARDING_ROUTINE_TITLES.weeklyKickoffRiskReview,
        description: "Review kickoff outcomes, milestone intent, dependencies, and key onboarding risks.",
        assigneeAgentId: technicalProjectLead.id,
        cronExpression: "0 11 * * 3",
        label: "Wednesdays at 11:00",
      });

      let projectIssues = await issuesApi.list(companyId, { projectId: project.id });
      let rootIssue = projectIssues.find((issue) =>
        (createdIssueRef && issue.identifier === createdIssueRef) || issue.title === taskTitle.trim(),
      ) ?? null;
      if (!rootIssue) {
        rootIssue = await issuesApi.create(
          companyId,
          buildOnboardingIssuePayload({
            title: taskTitle,
            description: taskDescription,
            assigneeAgentId: technicalProjectLead.id,
            projectId: project.id,
            goalId: onboardingProjectGoal.id,
          }),
        );
      } else if (
        rootIssue.assigneeAgentId !== technicalProjectLead.id
        || rootIssue.goalId !== onboardingProjectGoal.id
      ) {
        rootIssue = await issuesApi.update(rootIssue.id, {
          assigneeAgentId: technicalProjectLead.id,
          goalId: onboardingProjectGoal.id,
        });
      }
      await issuesApi.prepareContinuity(rootIssue.id, { tier: "normal" }).catch(() => undefined);

      const rootIssueRef = rootIssue.identifier ?? rootIssue.id;
      setCreatedIssueRef(rootIssueRef);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(companyId)
      });

      const roomParticipants = [
        ceo.id,
        officeOperator.id,
        technicalProjectLead.id,
        ...backendContinuityOwners.map((agent) => agent.id),
        ...qaEvalsContinuityOwners.map((agent) => agent.id),
      ];
      let kickoffRoom = (await conferenceRoomsApi.list(companyId)).find((room) => room.title === ONBOARDING_KICKOFF_ROOM_TITLE) ?? null;
      if (!kickoffRoom) {
        kickoffRoom = await conferenceRoomsApi.create(companyId, {
          title: ONBOARDING_KICKOFF_ROOM_TITLE,
          summary: "Kickoff coordination for the onboarding execution lane.",
          agenda: "Confirm scope, owned work breakdown, dependencies, milestone intent, and key risks.",
          kind: "project_leadership",
          issueIds: [rootIssue.id],
          participantAgentIds: roomParticipants,
        });
      } else {
        const mergedIssueIds = Array.from(new Set([...kickoffRoom.linkedIssues.map((issue) => issue.issueId), rootIssue.id]));
        const mergedParticipants = Array.from(new Set([...kickoffRoom.participants.map((participant) => participant.agentId), ...roomParticipants]));
        kickoffRoom = await conferenceRoomsApi.update(kickoffRoom.id, {
          issueIds: mergedIssueIds,
          participantAgentIds: mergedParticipants,
        });
      }
      const kickoffComments = await conferenceRoomsApi.listComments(kickoffRoom.id);
      if (!kickoffComments.some((comment) => comment.messageType === "question")) {
        await conferenceRoomsApi.addComment(kickoffRoom.id, {
          body: buildOnboardingKickoffQuestion({
            companyName: resolvedCompanyName,
            projectGoalTitle: onboardingProjectGoal.title,
          }),
          messageType: "question",
        });
      }

      projectIssues = await issuesApi.list(companyId, { projectId: project.id });
      let branchIssue = projectIssues.find((issue) => issue.title === ONBOARDING_BRANCH_TITLE) ?? null;
      if (!branchIssue) {
        const createdBranch = await issuesApi.mutateContinuityBranch(rootIssue.id, {
          action: "create",
          title: ONBOARDING_BRANCH_TITLE,
          description: "Inspect the bootstrap lane and return explicit parent-document updates.",
          purpose: "Exercise the branch-return path during onboarding.",
          scope: "Review the kickoff, docs, and startup risks; then propose parent updates.",
          budget: "$5 and one short execution slice",
          expectedReturnArtifact: "A branch-return document with explicit parent updates.",
          mergeCriteria: [
            "Record branch-return updates explicitly",
            "Keep parent continuity docs current",
          ],
          assigneeAgentId: primaryBackendContinuityOwner.id,
          priority: "medium",
        });
        branchIssue = "branchIssue" in createdBranch ? createdBranch.branchIssue : null;
      }
      if (branchIssue) {
        const branchDocuments = await issuesApi.listDocuments(branchIssue.id);
        if (!branchDocuments.some((document) => document.key === "branch-return")) {
          await issuesApi.returnContinuityBranch(rootIssue.id, branchIssue.id, {
            kind: "paperclip/issue-branch-return.v1",
            purposeScopeRecap: "Review the onboarding bootstrap lane and return explicit parent updates.",
            resultSummary: "Kickoff, docs, and startup risks were reviewed for the onboarding lane.",
            proposedParentUpdates: [
              {
                documentKey: "progress",
                action: "append",
                summary: "Recorded bootstrap branch return findings.",
                content: "Branch review completed. Carry forward the kickoff outcomes, risk owners, and next validation step into the parent progress log.",
              },
            ],
            mergeChecklist: [
              "Carry forward the branch-return summary into parent progress.",
              "Keep kickoff risks visible in the project risk log.",
            ],
            unresolvedRisks: [
              "Kickoff commitments can still drift if the project docs stop being updated.",
            ],
            openQuestions: [
              "Which onboarding acceptance check should be exercised next after the starter lane is inspected?",
            ],
            evidence: [
              "Onboarding kickoff room and project docs reviewed.",
            ],
            returnedArtifacts: [
              "branch-return",
            ],
          });
        }
      }

      let reviewIssue = projectIssues.find((issue) => issue.title === ONBOARDING_DEMO_TITLES.review) ?? null;
      if (!reviewIssue) {
        reviewIssue = await issuesApi.create(companyId, {
          title: ONBOARDING_DEMO_TITLES.review,
          description: "Demonstrate review-return findings on onboarding readiness.",
          assigneeAgentId: primaryQaEvalsContinuityOwner.id,
          projectId: project.id,
          goalId: onboardingProjectGoal.id,
          status: "todo",
          continuityTier: "normal",
          prepareContinuity: true,
        });
      }
      const reviewDocuments = await issuesApi.listDocuments(reviewIssue.id);
      if (!reviewDocuments.some((document) => document.key === "review-findings")) {
        await issuesApi.reviewReturn(reviewIssue.id, {
          decisionContext: "Onboarding readiness demo review",
          outcome: "changes_requested",
          findings: [
            {
              severity: "medium",
              category: "governance",
              title: "Kickoff outputs must stay durable",
              detail: "The onboarding lane should keep owned work, risks, and next actions in docs instead of relying on room chat alone.",
              requiredAction: "Update the project and issue continuity docs after each material kickoff or review outcome.",
              evidence: ["Onboarding kickoff and project docs."],
            },
          ],
          ownerNextAction: "Refresh the planning and risk docs, then resubmit the issue for readiness review.",
        });
      }

      let handoffIssue = projectIssues.find((issue) => issue.title === ONBOARDING_DEMO_TITLES.handoff) ?? null;
      if (!handoffIssue) {
        handoffIssue = await issuesApi.create(companyId, {
          title: ONBOARDING_DEMO_TITLES.handoff,
          description: "Demonstrate a structured handoff from project leadership to continuity ownership.",
          assigneeAgentId: technicalProjectLead.id,
          projectId: project.id,
          goalId: onboardingProjectGoal.id,
          status: "todo",
          continuityTier: "normal",
          prepareContinuity: true,
        });
      }
      const handoffDocuments = await issuesApi.listDocuments(handoffIssue.id);
      if (!handoffDocuments.some((document) => document.key === "handoff")) {
        await issuesApi.handoffContinuity(handoffIssue.id, {
          assigneeAgentId: primaryBackendContinuityOwner.id,
          reasonCode: "reassignment",
          exactNextAction: "Review the kickoff room, project docs, and demo findings, then continue the next onboarding improvement slice.",
          unresolvedBranches: [],
          openQuestions: [
            "Which readiness item should be turned into the next concrete implementation issue?",
          ],
          evidence: [
            "Onboarding kickoff room",
            "Project context, risks, and runbook",
          ],
        });
      }

      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(
        createdCompanyPrefix
          ? `/${createdCompanyPrefix}/issues/${rootIssueRef}`
          : `/issues/${rootIssueRef}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && companyName.trim()) handleStep1Next();
      else if (step === 2 && agentName.trim()) handleStep2Next();
      else if (step === 3 && taskTitle.trim()) handleStep3Next();
      else if (step === 4) handleLaunch();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          setRouteDismissed(true);
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Left half — form */}
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
              step === 1 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border">
                {(
                  [
                    { step: 1 as Step, label: "Company", icon: Building2 },
                    { step: 2 as Step, label: "Agent", icon: Bot },
                    { step: 3 as Step, label: "Task", icon: ListTodo },
                    { step: 4 as Step, label: "Launch", icon: Rocket }
                  ] as const
                ).map(({ step: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      s === step
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Step content */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Name your company</h3>
                      <p className="text-xs text-muted-foreground">
                        This is the organization your agents will work for.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Company name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Acme Corp"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyGoal.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Mission / goal
                    </label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
                      placeholder="What is this company trying to achieve? If left blank, Paperclip will scaffold a default goal from the company name."
                      value={companyGoal}
                      onChange={(e) => setCompanyGoal(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Create your first agent</h3>
                      <p className="text-xs text-muted-foreground">
                        Choose how this agent will run tasks.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Agent name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="CEO"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Adapter type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {recommendedAdapters.map((opt) => (
                        <button
                          key={opt.type}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.type
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.type;
                            setAdapterType(nextType);
                            if (nextType === "codex_local") {
                              if (!model) {
                                setModel(DEFAULT_CODEX_LOCAL_MODEL);
                              }
                              return;
                            }
                            if (nextType === "opencode_local") {
                              setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                              return;
                            }
                            setModel("");
                          }}
                        >
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              Recommended
                            </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.description}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowMoreAdapters((v) => !v)}
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )}
                      />
                      More Agent Adapter Types
                    </button>

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {moreAdapters.map((opt) => (
                           <button
                             key={opt.type}
                             disabled={!!opt.comingSoon}
                             className={cn(
                               "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                               opt.comingSoon
                                 ? "border-border opacity-40 cursor-not-allowed"
                                 : adapterType === opt.type
                                 ? "border-foreground bg-accent"
                                 : "border-border hover:bg-accent/50"
                             )}
                             onClick={() => {
                               if (opt.comingSoon) return;
                               const nextType = opt.type;
                              setAdapterType(nextType);
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? opt.disabledLabel ?? "Coming soon"
                                : opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-[var(--radix-popover-trigger-width)] p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-[240px] overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Adapter environment check
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Runs a live probe that asks the adapter CLI to
                            respond with hello.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this CEO adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <ListTodo className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Give it something to do</h3>
                      <p className="text-xs text-muted-foreground">
                        Give your agent a small task to start with — a bug fix,
                        a research question, writing a script.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Task title
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Research competitor pricing"
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Description (optional)
                    </label>
                    <textarea
                      ref={textareaRef}
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[120px] max-h-[300px] overflow-y-auto"
                      placeholder="Add more detail about what the agent should do..."
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Rocket className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Ready to launch</h3>
                      <p className="text-xs text-muted-foreground">
                        Everything is set up. Launching now will create the
                        starter task, wake the agent, and open the issue.
                      </p>
                    </div>
                  </div>
                  <div className="border border-border divide-y divide-border">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {companyName}
                        </p>
                        <p className="text-xs text-muted-foreground">Company</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {agentName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {getUIAdapter(adapterType).label}
                        </p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {taskTitle}
                        </p>
                        <p className="text-xs text-muted-foreground">Task</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (onboardingOptions.initialStep ?? 1) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || loading}
                      onClick={handleStep1Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() || loading || adapterEnvLoading
                      }
                      onClick={handleStep2Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!taskTitle.trim() || loading}
                      onClick={handleStep3Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 4 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Create & Open Issue"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                Hint: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
