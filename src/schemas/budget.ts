import { z } from "zod";

function nonNegativeNumber() {
  return z.number().finite().nonnegative();
}

export const BudgetThreshold = z
  .object({
    soft_cost_usd: nonNegativeNumber().optional(),
    hard_cost_usd: nonNegativeNumber().optional(),
    soft_tokens: z.number().int().nonnegative().optional(),
    hard_tokens: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.soft_cost_usd !== undefined &&
      value.hard_cost_usd !== undefined &&
      value.hard_cost_usd < value.soft_cost_usd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hard_cost_usd"],
        message: "hard_cost_usd must be >= soft_cost_usd"
      });
    }
    if (
      value.soft_tokens !== undefined &&
      value.hard_tokens !== undefined &&
      value.hard_tokens < value.soft_tokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hard_tokens"],
        message: "hard_tokens must be >= soft_tokens"
      });
    }
  });

export const ProviderTokenRateCardUsdPer1k = z
  .object({
    input: nonNegativeNumber(),
    cached_input: nonNegativeNumber().optional(),
    output: nonNegativeNumber(),
    reasoning_output: nonNegativeNumber().optional()
  })
  .strict();

export type BudgetThreshold = z.infer<typeof BudgetThreshold>;
export type ProviderTokenRateCardUsdPer1k = z.infer<typeof ProviderTokenRateCardUsdPer1k>;
