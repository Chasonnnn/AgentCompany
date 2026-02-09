import { ulid } from "ulid";

export type IdPrefix =
  | "cmp"
  | "team"
  | "agent"
  | "proj"
  | "task"
  | "ms"
  | "run"
  | "art"
  | "ctx"
  | "share"
  | "rev"
  | "help";

export function newId(prefix: IdPrefix): `${IdPrefix}_${string}` {
  return `${prefix}_${ulid()}`;
}

export function isIdWithPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`) && id.length > `${prefix}_`.length;
}

