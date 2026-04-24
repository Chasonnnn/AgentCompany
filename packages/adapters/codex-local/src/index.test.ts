import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_SPARK_MODEL,
  defaultCodexLocalFastModeForModel,
  models,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("exposes Spark as a selectable model without enabling GPT-5.5 Fast Mode defaults", () => {
    expect(models.map((model) => model.id)).toContain(CODEX_LOCAL_SPARK_MODEL);
    expect(defaultCodexLocalFastModeForModel(CODEX_LOCAL_SPARK_MODEL)).toBe(false);
  });
});
