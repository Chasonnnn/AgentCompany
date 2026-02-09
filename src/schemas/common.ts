import { z } from "zod";

export const SchemaVersion = z.number().int().positive();

export const Visibility = z.enum(["private_agent", "team", "managers", "org"]);

export const IsoDateTime = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime({ local: true }));

