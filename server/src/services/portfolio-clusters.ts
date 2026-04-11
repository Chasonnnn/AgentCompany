import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentProjectScopes, portfolioClusters, projects } from "@paperclipai/db";
import type {
  CreatePortfolioCluster,
  PortfolioCluster,
  UpdatePortfolioCluster,
} from "@paperclipai/shared";
import { normalizeProjectUrlKey } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

const DEFAULT_CLUSTER_NAME = "Core Portfolio";
const DEFAULT_CLUSTER_SLUG = "core-portfolio";

function normalizeClusterSlug(name: string, fallback: string) {
  const normalized = normalizeProjectUrlKey(name) ?? normalizeProjectUrlKey(fallback) ?? DEFAULT_CLUSTER_SLUG;
  return normalized;
}

function systemScopeGrantId(clusterId: string) {
  return `portfolio-cluster:${clusterId}:portfolio-director`;
}

function toPortfolioCluster(row: typeof portfolioClusters.$inferSelect): PortfolioCluster {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    slug: row.slug,
    summary: row.summary ?? null,
    status: row.status,
    sortOrder: row.sortOrder,
    executiveSponsorAgentId: row.executiveSponsorAgentId ?? null,
    portfolioDirectorAgentId: row.portfolioDirectorAgentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertExecutiveSponsorAgent(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  agentId: string | null | undefined,
) {
  if (!agentId) return null;
  const row = await dbOrTx
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Executive sponsor agent not found");
  if (row.companyId !== companyId) {
    throw unprocessable("Executive sponsor must belong to the same company");
  }
  if (row.status === "terminated") {
    throw unprocessable("Executive sponsor cannot be terminated");
  }
  if (row.orgLevel !== "executive") {
    throw unprocessable("Executive sponsor must be an executive agent");
  }
  return row;
}

async function assertPortfolioDirectorAgent(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  agentId: string | null | undefined,
) {
  if (!agentId) return null;
  const row = await dbOrTx
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Portfolio director agent not found");
  if (row.companyId !== companyId) {
    throw unprocessable("Portfolio director must belong to the same company");
  }
  if (row.status === "terminated") {
    throw unprocessable("Portfolio director cannot be terminated");
  }
  if (row.orgLevel !== "director") {
    throw unprocessable("Portfolio director must be a director-level agent");
  }
  return row;
}

export function portfolioClusterService(db: Db) {
  async function getClusterRow(id: string, dbOrTx: Pick<Db, "select"> = db) {
    return dbOrTx
      .select()
      .from(portfolioClusters)
      .where(eq(portfolioClusters.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureSlugAvailable(
    companyId: string,
    name: string,
    fallbackName: string,
    excludeClusterId?: string | null,
  ) {
    const base = normalizeClusterSlug(name, fallbackName);
    let candidate = base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const existing = await db
        .select({ id: portfolioClusters.id })
        .from(portfolioClusters)
        .where(
          and(
            eq(portfolioClusters.companyId, companyId),
            eq(portfolioClusters.slug, candidate),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.id === excludeClusterId) {
        return candidate;
      }
      candidate = `${base}-${suffix}`;
    }
    throw unprocessable("Unable to allocate unique portfolio cluster slug");
  }

  async function ensureDefaultClusterForCompany(companyId: string) {
    const existing = await db
      .select()
      .from(portfolioClusters)
      .where(eq(portfolioClusters.companyId, companyId))
      .orderBy(asc(portfolioClusters.sortOrder), asc(portfolioClusters.createdAt))
      .then((rows) => rows[0] ?? null);
    if (existing) return toPortfolioCluster(existing);

    const created = await db
      .insert(portfolioClusters)
      .values({
        companyId,
        name: DEFAULT_CLUSTER_NAME,
        slug: DEFAULT_CLUSTER_SLUG,
        summary: "Default portfolio cluster",
        status: "active",
        sortOrder: 0,
      })
      .returning()
      .then((rows) => rows[0]!);
    return toPortfolioCluster(created);
  }

  async function reconcilePortfolioDirectorScopes(clusterId: string, dbOrTx: Db = db) {
    const cluster = await getClusterRow(clusterId, dbOrTx);
    if (!cluster) throw notFound("Portfolio cluster not found");

    const now = new Date();
    const grantId = systemScopeGrantId(cluster.id);
    const clusterProjects = await dbOrTx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, cluster.companyId), eq(projects.portfolioClusterId, cluster.id)));
    const desiredProjectIds = new Set(clusterProjects.map((project) => project.id));

    const existingScopes = await dbOrTx
      .select()
      .from(agentProjectScopes)
      .where(
        and(
          eq(agentProjectScopes.companyId, cluster.companyId),
          eq(agentProjectScopes.scopeMode, "leadership_summary"),
          eq(agentProjectScopes.grantedByPrincipalType, "system_process"),
          eq(agentProjectScopes.grantedByPrincipalId, grantId),
          isNull(agentProjectScopes.activeTo),
        ),
      );

    const staleScopeIds = existingScopes
      .filter((scope) =>
        scope.agentId !== cluster.portfolioDirectorAgentId
        || !desiredProjectIds.has(scope.projectId))
      .map((scope) => scope.id);

    if (staleScopeIds.length > 0) {
      await dbOrTx
        .update(agentProjectScopes)
        .set({ activeTo: now, updatedAt: now })
        .where(inArray(agentProjectScopes.id, staleScopeIds));
    }

    if (!cluster.portfolioDirectorAgentId) return;

    const activeScopeKeys = new Set(
      existingScopes
        .filter((scope) => scope.agentId === cluster.portfolioDirectorAgentId && staleScopeIds.includes(scope.id) === false)
        .map((scope) => `${scope.agentId}:${scope.projectId}`),
    );

    const rowsToInsert = clusterProjects
      .filter((project) => !activeScopeKeys.has(`${cluster.portfolioDirectorAgentId}:${project.id}`))
      .map((project) => ({
        companyId: cluster.companyId,
        agentId: cluster.portfolioDirectorAgentId!,
        projectId: project.id,
        scopeMode: "leadership_summary" as const,
        projectRole: "director" as const,
        isPrimary: false,
        teamFunctionKey: null,
        teamFunctionLabel: null,
        workstreamKey: null,
        workstreamLabel: null,
        grantedByPrincipalType: "system_process" as const,
        grantedByPrincipalId: grantId,
        activeFrom: now,
        activeTo: null,
        createdAt: now,
        updatedAt: now,
      }));

    if (rowsToInsert.length > 0) {
      await dbOrTx.insert(agentProjectScopes).values(rowsToInsert);
    }
  }

  return {
    listForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(portfolioClusters)
        .where(eq(portfolioClusters.companyId, companyId))
        .orderBy(asc(portfolioClusters.sortOrder), asc(portfolioClusters.name));
      return rows.map(toPortfolioCluster);
    },

    getById: async (id: string) => {
      const row = await getClusterRow(id);
      return row ? toPortfolioCluster(row) : null;
    },

    ensureDefaultClusterForCompany,

    resolveClusterIdForProject: async (companyId: string, portfolioClusterId?: string | null) => {
      if (!portfolioClusterId) {
        return (await ensureDefaultClusterForCompany(companyId)).id;
      }
      const cluster = await getClusterRow(portfolioClusterId);
      if (!cluster || cluster.companyId !== companyId) {
        throw notFound("Portfolio cluster not found");
      }
      return cluster.id;
    },

    create: async (companyId: string, input: CreatePortfolioCluster) => {
      await assertExecutiveSponsorAgent(db, companyId, input.executiveSponsorAgentId);
      await assertPortfolioDirectorAgent(db, companyId, input.portfolioDirectorAgentId);
      const slug = await ensureSlugAvailable(companyId, input.slug ?? input.name, input.name);
      const nextSortOrder = input.sortOrder ?? (
        await db
          .select({ sortOrder: portfolioClusters.sortOrder })
          .from(portfolioClusters)
          .where(eq(portfolioClusters.companyId, companyId))
          .orderBy(asc(portfolioClusters.sortOrder))
          .then((rows) => ((rows[rows.length - 1]?.sortOrder ?? -1) + 1))
      );
      const created = await db
        .insert(portfolioClusters)
        .values({
          companyId,
          name: input.name.trim(),
          slug,
          summary: input.summary?.trim() || null,
          status: input.status ?? "active",
          sortOrder: nextSortOrder,
          executiveSponsorAgentId: input.executiveSponsorAgentId ?? null,
          portfolioDirectorAgentId: input.portfolioDirectorAgentId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);
      await reconcilePortfolioDirectorScopes(created.id);
      return toPortfolioCluster(created);
    },

    update: async (id: string, input: UpdatePortfolioCluster) => {
      const existing = await getClusterRow(id);
      if (!existing) return null;
      const nextExecutiveSponsorAgentId = input.executiveSponsorAgentId === undefined
        ? existing.executiveSponsorAgentId
        : input.executiveSponsorAgentId;
      const nextPortfolioDirectorAgentId = input.portfolioDirectorAgentId === undefined
        ? existing.portfolioDirectorAgentId
        : input.portfolioDirectorAgentId;
      await assertExecutiveSponsorAgent(db, existing.companyId, nextExecutiveSponsorAgentId);
      await assertPortfolioDirectorAgent(db, existing.companyId, nextPortfolioDirectorAgentId);
      const nextName = input.name?.trim() || existing.name;
      const nextSlug = input.slug !== undefined
        ? await ensureSlugAvailable(existing.companyId, input.slug ?? nextName, nextName, existing.id)
        : existing.slug;
      const updated = await db
        .update(portfolioClusters)
        .set({
          name: input.name?.trim() || undefined,
          slug: nextSlug,
          summary: input.summary !== undefined ? input.summary?.trim() || null : undefined,
          status: input.status,
          sortOrder: input.sortOrder,
          executiveSponsorAgentId: input.executiveSponsorAgentId === undefined
            ? undefined
            : input.executiveSponsorAgentId,
          portfolioDirectorAgentId: input.portfolioDirectorAgentId === undefined
            ? undefined
            : input.portfolioDirectorAgentId,
          updatedAt: new Date(),
        })
        .where(eq(portfolioClusters.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      await reconcilePortfolioDirectorScopes(updated.id);
      return toPortfolioCluster(updated);
    },

    reconcilePortfolioDirectorScopes,
  };
}
