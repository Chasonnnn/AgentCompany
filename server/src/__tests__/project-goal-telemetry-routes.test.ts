import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { goalRoutes } from "../routes/goals.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWorkspace: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));
const mockOfficeCoordinationService = vi.hoisted(() => ({
  findOfficeOperator: vi.fn(),
  buildWakeSnapshot: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  listProjectDocuments: vi.fn(),
  getProjectDocumentByKey: vi.fn(),
  listProjectDocumentRevisions: vi.fn(),
  upsertProjectDocument: vi.fn(),
  restoreProjectDocumentRevision: vi.fn(),
  deleteProjectDocument: vi.fn(),

}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackProjectCreated = vi.hoisted(() => vi.fn());
const mockTrackGoalCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());


vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  documentService: () => mockDocumentService,
  goalService: () => mockGoalService,
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  officeCoordinationService: () => mockOfficeCoordinationService,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createApp(route: express.Router) {

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", route);
  app.use(errorHandler);
  return app;
}

function createProjectApp() {
  return createApp(
    projectRoutes({} as any, {
      services: {
        documentService: mockDocumentService as any,
        heartbeatService: mockHeartbeatService as any,
        logActivity: mockLogActivity as any,
        officeCoordinationService: mockOfficeCoordinationService as any,
        projectService: mockProjectService as any,
        secretService: mockSecretService as any,
        workspaceOperationService: mockWorkspaceOperationService as any,
      },
      telemetry: {
        getTelemetryClient: mockGetTelemetryClient as any,
        trackProjectCreated: mockTrackProjectCreated as any,
      },
    }),
  );
}

function createGoalApp() {
  return createApp(
    goalRoutes({} as any, {
      services: {
        goalService: mockGoalService as any,
        logActivity: mockLogActivity as any,
      },
      telemetry: {
        getTelemetryClient: mockGetTelemetryClient as any,
        trackGoalCreated: mockTrackGoalCreated as any,
      },
    }),
  );
}

describe("project and goal telemetry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockEnvironmentService.getById.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockOfficeCoordinationService.findOfficeOperator.mockReset();
    mockOfficeCoordinationService.buildWakeSnapshot.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Telemetry project",
      description: null,
      status: "backlog",
    });
    mockGoalService.create.mockResolvedValue({
      id: "goal-1",
      companyId: "company-1",
      title: "Telemetry goal",
      description: null,
      level: "team",
      status: "planned",
    });
    mockOfficeCoordinationService.findOfficeOperator.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("emits telemetry when a project is created", async () => {
    const res = await request(createProjectApp())
      .post("/api/companies/company-1/projects")
      .send({ name: "Telemetry project" });

    expect([200, 201]).toContain(res.status);
    expect(mockTrackProjectCreated).toHaveBeenCalledWith(expect.anything());
  });

  it("emits telemetry when a goal is created", async () => {
    const res = await request(createGoalApp())
      .post("/api/companies/company-1/goals")
      .send({ title: "Telemetry goal", level: "team" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTrackGoalCreated).toHaveBeenCalledWith(expect.anything(), { goalLevel: "team" });
  });
});
