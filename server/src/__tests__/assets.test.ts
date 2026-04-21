import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";

function createAsset() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "asset-1",
    companyId: "company-1",
    provider: "local",
    objectKey: "assets/abc",
    contentType: "image/png",
    byteSize: 40,
    sha256: "sha256-sample",
    originalFilename: "logo.png",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
  };
}

function createStorageHarness(contentType = "image/png") {
  const calls = {
    putFile: [] as Array<
      [{
        companyId: string;
        namespace: string;
        originalFilename: string | null;
        contentType: string;
        body: Buffer;
      }]
    >,
  };

  const storage: StorageService = {
    provider: "local_disk",
    putFile: async (input) => {
      calls.putFile.push([input]);
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
        contentType: contentType || input.contentType,
        byteSize: input.body.length,
        sha256: "sha256-sample",
        originalFilename: input.originalFilename,
      };
    },
    getObject: async () => {
      throw new Error("not implemented");
    },
    headObject: async () => null,
    deleteObject: async () => undefined,
  };

  return { storage, calls };
}

async function createApp(storageHarness: ReturnType<typeof createStorageHarness>) {
  vi.doUnmock("../routes/assets.js");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../services/index.js");

  const state = {
    createdAsset: createAsset(),
    fetchedAsset: createAsset(),
  };

  const calls = {
    createAsset: [] as unknown[][],
    getAssetById: [] as unknown[][],
    logActivity: [] as unknown[][],
  };

  const [{ assetRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/assets.js")>("../routes/assets.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", assetRoutes({} as any, storageHarness.storage, {
    services: {
      assetService: {
        create: async (...args: unknown[]) => {
          calls.createAsset.push(args);
          return state.createdAsset;
        },
        getById: async (...args: unknown[]) => {
          calls.getAssetById.push(args);
          return state.fetchedAsset;
        },
      } as any,
      logActivity: async (...args: unknown[]) => {
        calls.logActivity.push(args);
      },
    },
  }));
  app.use(errorHandler);

  return { app, state, calls, storageCalls: storageHarness.calls };
}

describe("POST /api/companies/:companyId/assets/images", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
  });

  afterEach(() => {
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
  });

  it("accepts PNG image uploads and returns an asset path", async () => {
    const harness = await createApp(createStorageHarness("image/png"));

    const res = await request(harness.app)
      .post("/api/companies/company-1/assets/images")
      .field("namespace", "goals")
      .attach("file", Buffer.from("png"), "logo.png");

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(harness.calls.createAsset).toHaveLength(1);
    expect(harness.storageCalls.putFile).toEqual([[
      {
        companyId: "company-1",
        namespace: "assets/goals",
        originalFilename: "logo.png",
        contentType: "image/png",
        body: expect.any(Buffer),
      },
    ]]);
  });

  it("allows supported non-image attachments outside the company logo flow", async () => {
    const harness = await createApp(createStorageHarness("text/plain"));
    harness.state.createdAsset = {
      ...createAsset(),
      contentType: "text/plain",
      originalFilename: "note.txt",
    };

    const res = await request(harness.app)
      .post("/api/companies/company-1/assets/images")
      .field("namespace", "issues/drafts")
      .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(harness.storageCalls.putFile).toEqual([[
      {
        companyId: "company-1",
        namespace: "assets/issues/drafts",
        originalFilename: "note.txt",
        contentType: "text/plain",
        body: expect.any(Buffer),
      },
    ]]);
  });
});

describe("POST /api/companies/:companyId/logo", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
  });

  afterEach(() => {
    vi.doUnmock("../routes/assets.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../services/index.js");
  });

  it("accepts PNG logo uploads and returns an asset path", async () => {
    const harness = await createApp(createStorageHarness("image/png"));

    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("png"), "logo.png");

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(harness.calls.createAsset).toHaveLength(1);
    expect(harness.storageCalls.putFile).toEqual([[
      {
        companyId: "company-1",
        namespace: "assets/companies",
        originalFilename: "logo.png",
        contentType: "image/png",
        body: expect.any(Buffer),
      },
    ]]);
  });

  it("sanitizes SVG logo uploads before storing them", async () => {
    const harness = await createApp(createStorageHarness("image/svg+xml"));
    harness.state.createdAsset = {
      ...createAsset(),
      contentType: "image/svg+xml",
      originalFilename: "logo.svg",
    };

    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach(
        "file",
        Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
        ),
        "logo.svg",
      );

    expect(res.status).toBe(201);
    expect(harness.storageCalls.putFile).toHaveLength(1);
    const stored = harness.storageCalls.putFile[0]?.[0];
    expect(stored.contentType).toBe("image/svg+xml");
    expect(stored.originalFilename).toBe("logo.svg");
    const body = stored.body.toString("utf8");
    expect(body).toContain("<svg");
    expect(body).toContain("<circle");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onload=");
    expect(body).not.toContain("https://evil.example/");
  });

  it("allows logo uploads within the general attachment limit", async () => {
    const harness = await createApp(createStorageHarness("image/png"));

    const file = Buffer.alloc(150 * 1024, "a");
    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach("file", file, "within-limit.png");

    expect(res.status).toBe(201);
  });

  it("rejects logo files larger than the general attachment limit", async () => {
    const harness = await createApp(createStorageHarness());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach("file", file, "too-large.png");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  });

  it("rejects unsupported image types", async () => {
    const harness = await createApp(createStorageHarness("text/plain"));

    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("not an image"), {
        filename: "note.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: text/plain");
    expect(harness.calls.createAsset).toHaveLength(0);
  });

  it("rejects SVG image uploads that cannot be sanitized", async () => {
    const harness = await createApp(createStorageHarness("image/svg+xml"));

    const res = await request(harness.app)
      .post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("<notsvg></notsvg>"), "logo.svg");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SVG could not be sanitized");
    expect(harness.calls.createAsset).toHaveLength(0);
  });
});
