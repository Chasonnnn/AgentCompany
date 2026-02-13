import { ulid } from "ulid";

export type IdPrefix =
  | "cmp"
  | "team"
  | "agent"
  | "proj"
  | "conv"
  | "msg"
  | "task"
  | "ms"
  | "run"
  | "job"
  | "art"
  | "ctx"
  | "share"
  | "rev"
  | "help"
  | "cmt"
  | "evt";

export function newId(prefix: IdPrefix): `${IdPrefix}_${string}` {
  return `${prefix}_${ulid()}`;
}

export function isIdWithPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`) && id.length > `${prefix}_`.length;
}
