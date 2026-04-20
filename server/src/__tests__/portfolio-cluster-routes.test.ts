import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

function makeCluster(overrides: Record<string, unknown> = {}) {
  return {
    id: "cluster-1",
    companyId: "company-1",
    name: "Core Product",
    slug: "core-product",
    summary: "Primary revenue products",
    status: "active",
    sortOrder: 0,
    executiveSponsorAgentId: "agent-exec",
    portfolioDirectorAgentId: "agent-director",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createHarness(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const [{ errorHandler }, { portfolioClusterRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/portfolio-clusters.js"),
  ]);
  const portfolioClusterService = {
    listForCompany: vi.fn().mockResolvedValue([makeCluster()]),
    create: vi.fn().mockResolvedValue(makeCluster()),
    getById: vi.fn().mockResolvedValue(makeCluster()),
    update: vi.fn().mockResolvedValue(makeCluster({ name: "Platform" })),
  };
  const logActivity = vi.fn().mockResolvedValue(undefined);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", portfolioClusterRoutes({} as any, {
    logActivity,
    portfolioClusterService: portfolioClusterService as any,
  }));
  app.use(errorHandler);

  return { app, logActivity, portfolioClusterService };
}

describe("portfolio cluster routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("../services/index.js");
    vi.unmock("../middleware/validate.js");
  });

  it("lists clusters for an authorized company actor", async () => {
    const { app } = await createHarness();
    const res = await request(app).get("/api/companies/company-1/portfolio-clusters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: "cluster-1", name: "Core Product" })]);
  });

  it("creates a cluster for board actors", async () => {
    const { app } = await createHarness();
    const res = await request(app)
      .post("/api/companies/company-1/portfolio-clusters")
      .send({
        name: "Core Product",
        slug: "core-product",
        summary: "Primary revenue products",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ id: "cluster-1", name: "Core Product" }));
  });

  it("rejects cluster creation for non-board actors", async () => {
    const { app } = await createHarness({
      type: "agent",
      companyId: "company-1",
      companyIds: ["company-1"],
      agentId: "agent-1",
    });
    const res = await request(app)
      .post("/api/companies/company-1/portfolio-clusters")
      .send({
        name: "Core Product",
        slug: "core-product",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("updates a cluster for board actors", async () => {
    const { app } = await createHarness();
    const res = await request(app)
      .patch("/api/portfolio-clusters/cluster-1")
      .send({
        name: "Platform",
        summary: "Shared infrastructure and core systems",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: "cluster-1", name: "Platform" }));
  });
});
