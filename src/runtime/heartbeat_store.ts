import path from "node:path";
import { ensureDir, pathExists } from "../store/fs.js";
import { readYamlFile, writeYamlFile } from "../store/yaml.js";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_HEARTBEAT_STATE,
  HeartbeatConfig,
  HeartbeatState,
  type HeartbeatConfig as HeartbeatConfigType,
  type HeartbeatState as HeartbeatStateType
} from "../schemas/heartbeat.js";

export function heartbeatDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".local", "heartbeat");
}

export function heartbeatConfigPath(workspaceDir: string): string {
  return path.join(heartbeatDir(workspaceDir), "config.yaml");
}

export function heartbeatStatePath(workspaceDir: string): string {
  return path.join(heartbeatDir(workspaceDir), "state.yaml");
}

export async function readHeartbeatConfig(workspaceDir: string): Promise<HeartbeatConfigType> {
  const cfgPath = heartbeatConfigPath(workspaceDir);
  if (!(await pathExists(cfgPath))) {
    return HeartbeatConfig.parse(DEFAULT_HEARTBEAT_CONFIG);
  }
  const parsed = HeartbeatConfig.safeParse(await readYamlFile(cfgPath));
  if (!parsed.success) {
    return HeartbeatConfig.parse(DEFAULT_HEARTBEAT_CONFIG);
  }
  return HeartbeatConfig.parse({ ...DEFAULT_HEARTBEAT_CONFIG, ...parsed.data });
}

export async function writeHeartbeatConfig(args: {
  workspace_dir: string;
  config: Partial<HeartbeatConfigType>;
}): Promise<HeartbeatConfigType> {
  const dir = heartbeatDir(args.workspace_dir);
  await ensureDir(dir);
  const existing = await readHeartbeatConfig(args.workspace_dir);
  const merged = HeartbeatConfig.parse({ ...existing, ...args.config, schema_version: 1, type: "heartbeat_config" });
  await writeYamlFile(heartbeatConfigPath(args.workspace_dir), merged);
  return merged;
}

export async function readHeartbeatState(workspaceDir: string): Promise<HeartbeatStateType> {
  const stPath = heartbeatStatePath(workspaceDir);
  if (!(await pathExists(stPath))) {
    return HeartbeatState.parse(DEFAULT_HEARTBEAT_STATE);
  }
  const parsed = HeartbeatState.safeParse(await readYamlFile(stPath));
  if (!parsed.success) {
    return HeartbeatState.parse(DEFAULT_HEARTBEAT_STATE);
  }
  return HeartbeatState.parse({ ...DEFAULT_HEARTBEAT_STATE, ...parsed.data });
}

export async function writeHeartbeatState(args: {
  workspace_dir: string;
  state: HeartbeatStateType;
}): Promise<HeartbeatStateType> {
  const dir = heartbeatDir(args.workspace_dir);
  await ensureDir(dir);
  const normalized = HeartbeatState.parse({ ...args.state, schema_version: 1, type: "heartbeat_state" });
  await writeYamlFile(heartbeatStatePath(args.workspace_dir), normalized);
  return normalized;
}

export async function updateHeartbeatState(args: {
  workspace_dir: string;
  mutate: (state: HeartbeatStateType) => HeartbeatStateType | void;
}): Promise<HeartbeatStateType> {
  const current = await readHeartbeatState(args.workspace_dir);
  const next = args.mutate(current) ?? current;
  return writeHeartbeatState({ workspace_dir: args.workspace_dir, state: next });
}
