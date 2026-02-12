#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartManagerWebArgs {
  workspace_dir: String,
  project_id: String,
  actor_id: Option<String>,
  actor_role: Option<String>,
  actor_team_id: Option<String>,
  host: Option<String>,
  port: Option<u16>,
  monitor_limit: Option<u32>,
  pending_limit: Option<u32>,
  decisions_limit: Option<u32>,
  refresh_index: Option<bool>,
  sync_index: Option<bool>,
  node_bin: Option<String>,
  cli_path: Option<String>
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapWorkspaceArgs {
  workspace_dir: String,
  company_name: Option<String>,
  project_name: Option<String>,
  departments: Option<Vec<String>>,
  include_ceo: Option<bool>,
  include_director: Option<bool>,
  force: Option<bool>,
  node_bin: Option<String>,
  cli_path: Option<String>
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardAgentArgs {
  workspace_dir: String,
  name: String,
  role: String,
  provider: String,
  team_id: Option<String>,
  team_name: Option<String>,
  node_bin: Option<String>,
  cli_path: Option<String>
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagerWebStatus {
  running: bool,
  url: Option<String>,
  pid: Option<u32>,
  workspace_dir: Option<String>,
  project_id: Option<String>
}

struct ManagedProcess {
  child: Child,
  url: String,
  workspace_dir: String,
  project_id: String
}

#[derive(Default)]
struct UiProcessState {
  process: Mutex<Option<ManagedProcess>>
}

impl Drop for UiProcessState {
  fn drop(&mut self) {
    if let Ok(mut guard) = self.process.lock() {
      if let Some(mut p) = guard.take() {
        let _ = terminate_child(&mut p.child);
      }
    }
  }
}

impl ManagerWebStatus {
  fn idle() -> Self {
    Self {
      running: false,
      url: None,
      pid: None,
      workspace_dir: None,
      project_id: None
    }
  }
}

fn status_from_managed(p: &ManagedProcess) -> ManagerWebStatus {
  ManagerWebStatus {
    running: true,
    url: Some(p.url.clone()),
    pid: Some(p.child.id()),
    workspace_dir: Some(p.workspace_dir.clone()),
    project_id: Some(p.project_id.clone())
  }
}

fn valid_actor_role(role: &str) -> bool {
  matches!(role, "human" | "ceo" | "director" | "manager" | "worker")
}

fn valid_agent_role(role: &str) -> bool {
  matches!(role, "ceo" | "director" | "manager" | "worker")
}

fn parse_cli_json_output(stdout: &[u8]) -> Result<serde_json::Value, String> {
  let s = String::from_utf8(stdout.to_vec())
    .map_err(|e| format!("CLI stdout is not valid UTF-8: {}", e))?;
  serde_json::from_str::<serde_json::Value>(s.trim())
    .map_err(|e| format!("CLI returned non-JSON output: {} (output: {})", e, s.trim()))
}

fn parse_cli_text_output(stdout: &[u8]) -> Result<String, String> {
  let s = String::from_utf8(stdout.to_vec())
    .map_err(|e| format!("CLI stdout is not valid UTF-8: {}", e))?;
  let trimmed = s.trim();
  if trimmed.is_empty() {
    return Err("CLI returned empty output".to_string());
  }
  Ok(trimmed.to_string())
}

fn resolve_node_bin(explicit: Option<String>) -> String {
  if let Some(bin) = explicit {
    let trimmed = bin.trim();
    if !trimmed.is_empty() {
      return trimmed.to_string();
    }
  }
  if let Ok(bin) = std::env::var("AGENTCOMPANY_NODE_BIN") {
    let trimmed = bin.trim();
    if !trimmed.is_empty() {
      return trimmed.to_string();
    }
  }
  "node".to_string()
}

fn push_candidates(base: &Path, out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
  for ancestor in base.ancestors().take(8) {
    let candidate = ancestor.join("dist").join("cli.js");
    if seen.insert(candidate.clone()) {
      out.push(candidate);
    }
  }
}

fn discover_cli_candidates() -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = Vec::new();
  let mut seen: HashSet<PathBuf> = HashSet::new();

  if let Ok(cwd) = std::env::current_dir() {
    push_candidates(&cwd, &mut out, &mut seen);
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      push_candidates(dir, &mut out, &mut seen);
    }
  }

  out
}

fn resolve_cli_path(explicit: Option<String>) -> Result<PathBuf, String> {
  if let Some(raw) = explicit {
    let p = PathBuf::from(raw.trim());
    if p.is_file() {
      return Ok(p);
    }
    return Err(format!("CLI path does not exist: {}", p.display()));
  }

  if let Ok(raw) = std::env::var("AGENTCOMPANY_CLI_PATH") {
    let p = PathBuf::from(raw.trim());
    if p.is_file() {
      return Ok(p);
    }
    return Err(format!(
      "AGENTCOMPANY_CLI_PATH is set but does not exist: {}",
      p.display()
    ));
  }

  for candidate in discover_cli_candidates() {
    if candidate.is_file() {
      return Ok(candidate);
    }
  }

  Err(
    "Unable to find dist/cli.js. Run `pnpm build` and/or set AGENTCOMPANY_CLI_PATH to the absolute dist/cli.js path."
      .to_string(),
  )
}

fn terminate_child(child: &mut Child) -> Result<(), String> {
  if let Ok(Some(_)) = child.try_wait() {
    return Ok(());
  }

  match child.kill() {
    Ok(_) => {}
    Err(e) => {
      if e.kind() != std::io::ErrorKind::InvalidInput {
        return Err(format!("Failed to stop Manager Web process: {}", e));
      }
    }
  }

  match child.wait() {
    Ok(_) => Ok(()),
    Err(e) => Err(format!("Failed waiting for Manager Web process to exit: {}", e))
  }
}

#[tauri::command]
fn manager_web_status(state: State<'_, UiProcessState>) -> Result<ManagerWebStatus, String> {
  let mut guard = state
    .process
    .lock()
    .map_err(|_| "Failed to lock Manager Web process state".to_string())?;

  if let Some(existing) = guard.as_mut() {
    match existing.child.try_wait() {
      Ok(Some(_)) => {
        *guard = None;
        Ok(ManagerWebStatus::idle())
      }
      Ok(None) => Ok(status_from_managed(existing)),
      Err(e) => Err(format!("Failed to check Manager Web process status: {}", e))
    }
  } else {
    Ok(ManagerWebStatus::idle())
  }
}

#[tauri::command]
fn stop_manager_web(state: State<'_, UiProcessState>) -> Result<ManagerWebStatus, String> {
  let mut guard = state
    .process
    .lock()
    .map_err(|_| "Failed to lock Manager Web process state".to_string())?;

  if let Some(mut existing) = guard.take() {
    terminate_child(&mut existing.child)?;
  }

  Ok(ManagerWebStatus::idle())
}

#[tauri::command]
fn start_manager_web(
  state: State<'_, UiProcessState>,
  args: StartManagerWebArgs
) -> Result<ManagerWebStatus, String> {
  let workspace_dir = args.workspace_dir.trim();
  let project_id = args.project_id.trim();

  if workspace_dir.is_empty() {
    return Err("workspace_dir is required".to_string());
  }
  if project_id.is_empty() {
    return Err("project_id is required".to_string());
  }

  let actor_id = args
    .actor_id
    .unwrap_or_else(|| "human".to_string())
    .trim()
    .to_string();
  if actor_id.is_empty() {
    return Err("actor_id cannot be empty".to_string());
  }

  let actor_role = args
    .actor_role
    .unwrap_or_else(|| "manager".to_string())
    .trim()
    .to_string();
  if !valid_actor_role(&actor_role) {
    return Err("actor_role must be one of: human, ceo, director, manager, worker".to_string());
  }

  let host = args
    .host
    .unwrap_or_else(|| "127.0.0.1".to_string())
    .trim()
    .to_string();
  if host.is_empty() {
    return Err("host cannot be empty".to_string());
  }

  let port = args.port.unwrap_or(8787);
  if port == 0 {
    return Err("port must be between 1 and 65535".to_string());
  }

  let node_bin = resolve_node_bin(args.node_bin);
  let cli_path = resolve_cli_path(args.cli_path)?;

  let mut guard = state
    .process
    .lock()
    .map_err(|_| "Failed to lock Manager Web process state".to_string())?;

  if let Some(existing) = guard.as_mut() {
    match existing.child.try_wait() {
      Ok(None) => {
        let same_target = existing.workspace_dir == workspace_dir && existing.project_id == project_id;
        if same_target {
          return Ok(status_from_managed(existing));
        }
        terminate_child(&mut existing.child)?;
        *guard = None;
      }
      Ok(Some(_)) => {
        *guard = None;
      }
      Err(e) => {
        return Err(format!("Failed to inspect existing Manager Web process: {}", e));
      }
    }
  }

  let mut command = Command::new(node_bin);
  command
    .arg(cli_path)
    .arg("ui:web")
    .arg(workspace_dir)
    .arg("--project")
    .arg(project_id)
    .arg("--actor")
    .arg(&actor_id)
    .arg("--role")
    .arg(&actor_role)
    .arg("--host")
    .arg(&host)
    .arg("--port")
    .arg(port.to_string())
    .arg("--monitor-limit")
    .arg(args.monitor_limit.unwrap_or(200).to_string())
    .arg("--pending-limit")
    .arg(args.pending_limit.unwrap_or(200).to_string())
    .arg("--decisions-limit")
    .arg(args.decisions_limit.unwrap_or(200).to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit());

  if let Some(team) = args.actor_team_id {
    let trimmed = team.trim();
    if !trimmed.is_empty() {
      command.arg("--team").arg(trimmed);
    }
  }

  if args.refresh_index.unwrap_or(false) {
    command.arg("--refresh-index");
  }
  if args.sync_index == Some(false) {
    command.arg("--no-sync-index");
  }

  let child = command
    .spawn()
    .map_err(|e| format!("Failed to start Manager Web process: {}", e))?;

  let url = format!("http://{}:{}", host, port);
  let managed = ManagedProcess {
    child,
    url: url.clone(),
    workspace_dir: workspace_dir.to_string(),
    project_id: project_id.to_string()
  };

  let status = status_from_managed(&managed);
  *guard = Some(managed);
  Ok(status)
}

#[tauri::command]
fn bootstrap_workspace(args: BootstrapWorkspaceArgs) -> Result<serde_json::Value, String> {
  let workspace_dir = args.workspace_dir.trim();
  if workspace_dir.is_empty() {
    return Err("workspace_dir is required".to_string());
  }

  let node_bin = resolve_node_bin(args.node_bin);
  let cli_path = resolve_cli_path(args.cli_path)?;

  let mut command = Command::new(node_bin);
  command.arg(cli_path).arg("workspace:bootstrap").arg(workspace_dir);

  if let Some(name) = args.company_name {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
      command.arg("--name").arg(trimmed);
    }
  }
  if let Some(project_name) = args.project_name {
    let trimmed = project_name.trim();
    if !trimmed.is_empty() {
      command.arg("--project-name").arg(trimmed);
    }
  }

  let departments = args.departments.unwrap_or_else(|| vec![]);
  let normalized_departments: Vec<String> = departments
    .into_iter()
    .map(|d| d.trim().to_string())
    .filter(|d| !d.is_empty())
    .collect();
  if !normalized_departments.is_empty() {
    command.arg("--departments");
    for dep in normalized_departments {
      command.arg(dep);
    }
  }

  if args.include_ceo == Some(false) {
    command.arg("--no-ceo");
  }
  if args.include_director == Some(false) {
    command.arg("--no-director");
  }
  if args.force.unwrap_or(false) {
    command.arg("--force");
  }

  command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  let output = command
    .output()
    .map_err(|e| format!("Failed to run workspace bootstrap: {}", e))?;
  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    return Err(format!("Workspace bootstrap failed: {}", detail));
  }

  parse_cli_json_output(&output.stdout)
}

#[tauri::command]
fn onboard_agent(args: OnboardAgentArgs) -> Result<serde_json::Value, String> {
  let workspace_dir = args.workspace_dir.trim();
  if workspace_dir.is_empty() {
    return Err("workspace_dir is required".to_string());
  }
  let name = args.name.trim();
  if name.is_empty() {
    return Err("name is required".to_string());
  }
  let role = args.role.trim().to_lowercase();
  if !valid_agent_role(&role) {
    return Err("role must be one of: ceo, director, manager, worker".to_string());
  }
  let provider = args.provider.trim();
  if provider.is_empty() {
    return Err("provider is required".to_string());
  }

  let node_bin = resolve_node_bin(args.node_bin);
  let cli_path = resolve_cli_path(args.cli_path)?;
  let mut created_team = false;
  let mut team_id = args
    .team_id
    .as_ref()
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());

  if role != "ceo" && team_id.is_none() {
    if let Some(team_name_raw) = args.team_name {
      let team_name = team_name_raw.trim().to_string();
      if !team_name.is_empty() {
        let output = Command::new(&node_bin)
          .arg(&cli_path)
          .arg("team:new")
          .arg(workspace_dir)
          .arg("--name")
          .arg(&team_name)
          .stdin(Stdio::null())
          .stdout(Stdio::piped())
          .stderr(Stdio::piped())
          .output()
          .map_err(|e| format!("Failed to create team: {}", e))?;
        if !output.status.success() {
          let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
          let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
          let detail = if !stderr.is_empty() { stderr } else { stdout };
          return Err(format!("Team onboarding failed: {}", detail));
        }
        team_id = Some(parse_cli_text_output(&output.stdout)?);
        created_team = true;
      }
    }
  }

  let mut command = Command::new(node_bin);
  command
    .arg(cli_path)
    .arg("agent:new")
    .arg(workspace_dir)
    .arg("--name")
    .arg(name)
    .arg("--role")
    .arg(&role)
    .arg("--provider")
    .arg(provider);
  if let Some(team) = &team_id {
    command.arg("--team").arg(team);
  }

  let output = command
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|e| format!("Failed to onboard agent: {}", e))?;
  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    return Err(format!("Agent onboarding failed: {}", detail));
  }
  let agent_id = parse_cli_text_output(&output.stdout)?;

  Ok(serde_json::json!({
    "workspace_dir": workspace_dir,
    "agent_id": agent_id,
    "name": name,
    "role": role,
    "provider": provider,
    "team_id": team_id,
    "created_team": created_team
  }))
}

fn main() {
  tauri::Builder::default()
    .manage(UiProcessState::default())
    .invoke_handler(tauri::generate_handler![
      start_manager_web,
      stop_manager_web,
      manager_web_status,
      bootstrap_workspace,
      onboard_agent
    ])
    .run(tauri::generate_context!())
    .expect("error while running AgentCompany Desktop");
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  #[test]
  fn role_validation_accepts_known_roles() {
    assert!(valid_actor_role("human"));
    assert!(valid_actor_role("ceo"));
    assert!(valid_actor_role("director"));
    assert!(valid_actor_role("manager"));
    assert!(valid_actor_role("worker"));
    assert!(!valid_actor_role("admin"));
  }

  #[test]
  fn agent_role_validation_accepts_org_roles() {
    assert!(valid_agent_role("ceo"));
    assert!(valid_agent_role("director"));
    assert!(valid_agent_role("manager"));
    assert!(valid_agent_role("worker"));
    assert!(!valid_agent_role("human"));
    assert!(!valid_agent_role("admin"));
  }

  #[test]
  fn resolve_cli_path_accepts_explicit_existing_path() {
    let base = std::env::temp_dir().join(format!(
      "agentcompany-cli-path-test-{}",
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock should be after epoch")
        .as_nanos()
    ));
    let dist = base.join("dist");
    fs::create_dir_all(&dist).expect("create temp dist dir");
    let cli = dist.join("cli.js");
    fs::write(&cli, "#!/usr/bin/env node\nconsole.log('ok');\n").expect("write temp cli.js");

    let resolved = resolve_cli_path(Some(cli.display().to_string())).expect("resolve explicit path");
    assert_eq!(resolved, cli);

    let _ = fs::remove_dir_all(base);
  }
}
