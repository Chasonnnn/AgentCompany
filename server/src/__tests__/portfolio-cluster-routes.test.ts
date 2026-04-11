import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPortfolioClusterService = vi.hoisted(() => ({
  listForCompany: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  portfolioClusterService: () => mockPortfolioClusterService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const [{ portfolioClusterRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/portfolio-clusters.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", portfolioClusterRoutes({} as any));
  app.use(errorHandler);
  return app;
}

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

describe("portfolio cluster routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPortfolioClusterService.listForCompany.mockResolvedValue([makeCluster()]);
    mockPortfolioClusterService.create.mockResolvedValue(makeCluster());
    mockPortfolioClusterService.getById.mockResolvedValue(makeCluster());
    mockPortfolioClusterService.update.mockResolvedValue(makeCluster({ name: "Platform" }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists clusters for an authorized company actor", async () => {
    const res = await request(await createApp()).get("/api/companies/company-1/portfolio-clusters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockPortfolioClusterService.listForCompany).toHaveBeenCalledWith("company-1");
  });

  it("creates a cluster for board actors", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/portfolio-clusters")
      .send({
        name: "Core Product",
        slug: "core-product",
        summary: "Primary revenue products",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockPortfolioClusterService.create).toHaveBeenCalledWith("company-1", {
      name: "Core Product",
      slug: "core-product",
      summary: "Primary revenue products",
      status: "active",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "portfolio_cluster.created",
        entityId: "cluster-1",
      }),
    );
  });

  it("rejects cluster creation for non-board actors", async () => {
    const res = await request(await createApp({
      type: "agent",
      companyId: "company-1",
      companyIds: ["company-1"],
      agentId: "agent-1",
    }))
      .post("/api/companies/company-1/portfolio-clusters")
      .send({
        name: "Core Product",
        slug: "core-product",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockPortfolioClusterService.create).not.toHaveBeenCalled();
  });

  it("updates a cluster for board actors", async () => {
    const res = await request(await createApp())
      .patch("/api/portfolio-clusters/cluster-1")
      .send({
        name: "Platform",
        summary: "Shared infrastructure and core systems",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockPortfolioClusterService.getById).toHaveBeenCalledWith("cluster-1");
    expect(mockPortfolioClusterService.update).toHaveBeenCalledWith("cluster-1", {
      name: "Platform",
      summary: "Shared infrastructure and core systems",
    });
  });
});
