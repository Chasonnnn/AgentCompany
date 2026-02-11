import { z } from "zod";
import { SchemaVersion } from "./common.js";
import { ProviderTokenRateCardUsdPer1k } from "./budget.js";

export const MachineYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("machine"),
  repo_roots: z.record(z.string(), z.string()),
  provider_bins: z.record(z.string(), z.string()),
  provider_pricing_usd_per_1k_tokens: z
    .record(z.string(), ProviderTokenRateCardUsdPer1k)
    .optional()
});

export type MachineYaml = z.infer<typeof MachineYaml>;
