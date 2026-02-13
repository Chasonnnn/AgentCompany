import { z } from "zod";
import { SchemaVersion } from "./common.js";
import { ProviderTokenRateCardUsdPer1k } from "./budget.js";

export const ProviderExecutionChannel = z.enum(["subscription_cli", "api"]);

export const ProviderExecutionPolicy = z
  .object({
    channel: ProviderExecutionChannel,
    require_subscription_proof: z.boolean(),
    proof_strategy: z.string().min(1).optional(),
    allowed_bin_patterns: z.array(z.string().min(1))
  })
  .strict();
export type ProviderExecutionPolicy = z.infer<typeof ProviderExecutionPolicy>;

export const MachineYaml = z.object({
  schema_version: SchemaVersion,
  type: z.literal("machine"),
  repo_roots: z.record(z.string(), z.string()),
  provider_bins: z.record(z.string(), z.string()),
  provider_execution_policy: z.record(z.string(), ProviderExecutionPolicy).optional(),
  provider_pricing_usd_per_1k_tokens: z
    .record(z.string(), ProviderTokenRateCardUsdPer1k)
    .optional()
});

export type MachineYaml = z.infer<typeof MachineYaml>;
