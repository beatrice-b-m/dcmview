use anyhow::{Context, Result};
use clap::Parser;
use dcmview::annotations;
use dcmview::loader;
use dcmview::pixels;
use dcmview::server::{self, now_unix_ms, AppState, ServerConfig, TunnelConfig};
use dcmview::types;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VSCODE_BRIDGE_URL_ENV: &str = "DCMVIEW_VSCODE_BRIDGE_URL";
const VSCODE_BRIDGE_TOKEN_ENV: &str = "DCMVIEW_VSCODE_BRIDGE_TOKEN";
const VSCODE_BRIDGE_BYPASS_ENV: &str = "DCMVIEW_VSCODE_BYPASS";
const VSCODE_BRIDGE_REGISTRY_DIR_ENV: &str = "DCMVIEW_VSCODE_BRIDGE_REGISTRY_DIR";

#[derive(Debug, Parser)]
#[command(name = "dcmview", version, about = "Ephemeral DICOM inspection server")]
struct Cli {
    #[arg(required_unless_present = "vscode_bridge_client")]
    paths: Vec<PathBuf>,

    #[arg(short = 'p', long = "port", default_value_t = 0)]
    port: u16,

    #[arg(long = "host", default_value = "127.0.0.1")]
    host: String,

    #[arg(long = "no-browser")]
    no_browser: bool,

    #[arg(long = "tunnel")]
    tunnel: bool,

    #[arg(long = "tunnel-host")]
    tunnel_host: Option<String>,

    #[arg(long = "tunnel-port", default_value_t = 0)]
    tunnel_port: u16,

    #[arg(long = "timeout")]
    timeout: Option<u64>,

    #[arg(long = "no-recursive")]
    no_recursive: bool,

    #[arg(long = "annotations")]
    annotations: Option<PathBuf>,

    #[arg(long = "startup-json")]
    startup_json: bool,

    #[arg(
        long = "vscode-bridge-client",
        hide = true,
        num_args = 1..,
        allow_hyphen_values = true
    )]
    vscode_bridge_client: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeLaunchRequest {
    program: String,
    args: Vec<String>,
    cwd: String,
    wait: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeLaunchResponse {
    session_id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWaitResponse {
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BridgeEndpoint {
    url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRegistryEntry {
    bridge_url: String,
    token: String,
    workspace_roots: Option<Vec<String>>,
    created_at_ms: Option<u64>,
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(exit_code) => {
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
        Err(error) => {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<i32> {
    let program_name = env::args().next().unwrap_or_else(|| "dcmview".to_string());
    let raw_args = env::args().skip(1).collect::<Vec<_>>();
    let cli = Cli::parse_from(std::iter::once(program_name).chain(raw_args.clone()));

    if let Some(bridge_args) = cli.vscode_bridge_client {
        return run_vscode_bridge_client(bridge_args).await;
    }

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bridge_endpoints = discover_vscode_bridge_endpoints(&cwd);
    if !bridge_endpoints.is_empty() {
        match run_vscode_bridge_launch("dcmview", &raw_args, &bridge_endpoints).await {
            Ok(exit_code) => return Ok(exit_code),
            Err(error) => {
                eprintln!(
                    "dcmview: VS Code bridge unavailable ({error}); falling back to local viewer"
                );
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter("info,jpeg2k=warn")
        .init();

    let load_report = loader::discover(
        &cli.paths,
        loader::DiscoverOptions {
            recursive: !cli.no_recursive,
        },
    )
    .await
    .context("failed to discover DICOM files")?;

    print_load_summary(&load_report, &cli.paths);
    let annotations = if let Some(path) = cli.annotations.as_ref() {
        annotations::load_annotations_for_files(path, load_report.files.as_slice())
            .with_context(|| format!("failed to load annotations from {}", path.display()))?
    } else {
        HashMap::new()
    };

    let tunnel = if cli.tunnel {
        let host = cli
            .tunnel_host
            .clone()
            .ok_or_else(|| anyhow::anyhow!("dcmview: --tunnel requires --tunnel-host"))?;
        Some(TunnelConfig {
            host,
            port: cli.tunnel_port,
        })
    } else {
        None
    };

    let file_summaries = server::file_summaries(load_report.files.as_slice());
    let state = AppState {
        files: Arc::new(load_report.files),
        file_summaries,
        pixel_cache: pixels::new_cache(),
        raw_cache: pixels::new_raw_cache(),
        tag_cache: Arc::new(Mutex::new(HashMap::new())),
        annotations: annotations::AnnotationStore::new(annotations),
        tunnel_info: None,
        tunnel_handle: None,
        server_start: Instant::now(),
        server_start_ms: now_unix_ms(),
        last_request: Arc::new(AtomicU64::new(now_unix_ms())),
    };

    let run_result = server::run(
        ServerConfig {
            host: cli.host,
            port: cli.port,
            timeout_seconds: cli.timeout,
            open_browser: !cli.no_browser,
            startup_json: cli.startup_json,
            tunnel,
        },
        state,
    )
    .await;

    match run_result {
        Ok(()) => Ok(0),
        Err(error) => {
            let message = error.to_string();
            if cli.port != 0
                && (message.contains("Address already in use")
                    || message.contains("failed to bind"))
            {
                Err(anyhow::anyhow!(
                    "dcmview: port {} is already in use — try --port 0 for auto-assign",
                    cli.port
                ))
            } else {
                Err(error)
            }
        }
    }
}

async fn run_vscode_bridge_client(values: Vec<String>) -> Result<i32> {
    let Some((program, args)) = values.split_first() else {
        return Ok(1);
    };

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bridge_endpoints = discover_vscode_bridge_endpoints(&cwd);
    if bridge_endpoints.is_empty() {
        return fallback_to_local_viewer(args);
    }

    match run_vscode_bridge_launch(program, args, &bridge_endpoints).await {
        Ok(exit_code) => Ok(exit_code),
        Err(error) => {
            eprintln!(
                "dcmview: VS Code bridge unavailable ({error}); falling back to local viewer"
            );
            fallback_to_local_viewer(args)
        }
    }
}

async fn run_vscode_bridge_launch(
    program: &str,
    args: &[String],
    bridge_endpoints: &[BridgeEndpoint],
) -> Result<i32> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to create VS Code bridge HTTP client")?;
    let launch = BridgeLaunchRequest {
        program: program.to_string(),
        args: args.to_vec(),
        cwd: env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .display()
            .to_string(),
        wait: false,
    };

    let mut last_error = None;
    for endpoint in bridge_endpoints {
        match launch_vscode_session(&client, endpoint, &launch).await {
            Ok(launch_response) => {
                return wait_for_launched_vscode_session(&client, endpoint, launch_response).await;
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no VS Code bridge endpoints available")))
}

async fn launch_vscode_session(
    client: &reqwest::Client,
    endpoint: &BridgeEndpoint,
    launch: &BridgeLaunchRequest,
) -> Result<BridgeLaunchResponse> {
    let launch_url = format!("{}/launch", endpoint.url.trim_end_matches('/'));
    let response = client
        .post(launch_url)
        .bearer_auth(&endpoint.token)
        .json(launch)
        .send()
        .await
        .context("failed to contact VS Code bridge")?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "VS Code bridge returned {}",
            response.status()
        ));
    }
    response
        .json::<BridgeLaunchResponse>()
        .await
        .context("failed to parse VS Code bridge launch response")
}

async fn wait_for_launched_vscode_session(
    client: &reqwest::Client,
    endpoint: &BridgeEndpoint,
    launch_response: BridgeLaunchResponse,
) -> Result<i32> {
    println!("dcmview: opened in VS Code at {}", launch_response.url);
    let wait_url = format!(
        "{}/sessions/{}/wait",
        endpoint.url.trim_end_matches('/'),
        launch_response.session_id
    );
    let stop_url = format!(
        "{}/sessions/{}/stop",
        endpoint.url.trim_end_matches('/'),
        launch_response.session_id
    );
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(windows)]
    let ctrl_break = async {
        let mut signal =
            tokio::signal::windows::ctrl_break().context("failed to listen for Ctrl+Break")?;
        signal.recv().await;
        Ok::<(), anyhow::Error>(())
    };

    #[cfg(not(windows))]
    let ctrl_break = std::future::pending::<Result<()>>();

    tokio::select! {
        wait_result = wait_for_vscode_session(client, &wait_url, &endpoint.token) => wait_result,
        signal_result = ctrl_c => {
            signal_result.context("failed to listen for Ctrl+C")?;
            let _ = client.post(stop_url).bearer_auth(&endpoint.token).send().await;
            Ok(130)
        },
        signal_result = ctrl_break => {
            signal_result?;
            let _ = client.post(stop_url).bearer_auth(&endpoint.token).send().await;
            Ok(130)
        }
    }
}

fn discover_vscode_bridge_endpoints(cwd: &Path) -> Vec<BridgeEndpoint> {
    if env::var(VSCODE_BRIDGE_BYPASS_ENV).as_deref() == Ok("1") {
        return Vec::new();
    }

    if let (Ok(url), Ok(token)) = (
        env::var(VSCODE_BRIDGE_URL_ENV),
        env::var(VSCODE_BRIDGE_TOKEN_ENV),
    ) {
        if !url.is_empty() && !token.is_empty() {
            return vec![BridgeEndpoint { url, token }];
        }
    }

    discover_vscode_bridge_registry_endpoints(cwd)
}

fn discover_vscode_bridge_registry_endpoints(cwd: &Path) -> Vec<BridgeEndpoint> {
    let registry_dir = vscode_bridge_registry_dir();
    let Ok(entries) = fs::read_dir(registry_dir) else {
        return Vec::new();
    };
    let cwd = normalized_path(cwd);
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(registry) = serde_json::from_str::<BridgeRegistryEntry>(&contents) else {
            continue;
        };
        if registry.bridge_url.is_empty() || registry.token.is_empty() {
            continue;
        }
        let match_score =
            workspace_match_score(&cwd, registry.workspace_roots.as_deref().unwrap_or(&[]));
        let created_at = registry.created_at_ms.unwrap_or(0);
        candidates.push((
            match_score,
            created_at,
            BridgeEndpoint {
                url: registry.bridge_url,
                token: registry.token,
            },
        ));
    }
    candidates.sort_by(|left, right| (right.0, right.1).cmp(&(left.0, left.1)));

    let mut endpoints = Vec::new();
    for (_, _, endpoint) in candidates {
        if !endpoints.contains(&endpoint) {
            endpoints.push(endpoint);
        }
    }
    endpoints
}

fn vscode_bridge_registry_dir() -> PathBuf {
    if let Ok(configured) = env::var(VSCODE_BRIDGE_REGISTRY_DIR_ENV) {
        if !configured.is_empty() {
            return PathBuf::from(configured);
        }
    }

    if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR") {
        let runtime_dir = PathBuf::from(runtime_dir);
        if runtime_dir.is_absolute() {
            return runtime_dir.join("dcmview").join("vscode-bridges");
        }
    }

    let user = env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "default".to_string());
    env::temp_dir().join(format!(
        "dcmview-vscode-bridges-{}",
        safe_registry_segment(&user)
    ))
}

fn safe_registry_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn normalized_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn workspace_match_score(cwd: &Path, workspace_roots: &[String]) -> usize {
    workspace_roots
        .iter()
        .filter_map(|root| {
            let root = normalized_path(Path::new(root));
            cwd.strip_prefix(&root).ok().map(|_| root.as_os_str().len())
        })
        .max()
        .unwrap_or(0)
}

async fn wait_for_vscode_session(
    client: &reqwest::Client,
    wait_url: &str,
    token: &str,
) -> Result<i32> {
    let response = client
        .get(wait_url)
        .bearer_auth(token)
        .send()
        .await
        .context("failed to wait for VS Code dcmview session")?;
    if !response.status().is_success() {
        return Ok(1);
    }
    let wait_response = response.json::<BridgeWaitResponse>().await?;
    Ok(wait_response.exit_code.unwrap_or(0))
}

fn fallback_to_local_viewer(args: &[String]) -> Result<i32> {
    let status = Command::new(env::current_exe().context("failed to resolve current executable")?)
        .args(args)
        .env(VSCODE_BRIDGE_BYPASS_ENV, "1")
        .status()
        .context("failed to run local dcmview fallback")?;
    Ok(status.code().unwrap_or(1))
}

fn print_load_summary(report: &types::LoadReport, input_paths: &[PathBuf]) {
    let recursive_note = if report.searched_recursive {
        "searched recursively"
    } else {
        "searched top-level only"
    };
    let path_label = if input_paths.len() == 1 {
        input_paths[0].display().to_string()
    } else {
        format!("{} path(s)", input_paths.len())
    };

    if report.skipped == 0 {
        if report.files.len() == 1 {
            println!("dcmview: loaded 1 DICOM file");
        } else {
            println!(
                "dcmview: loaded {} DICOM file(s) from {} ({})",
                report.files.len(),
                path_label,
                recursive_note
            );
        }
    } else {
        println!(
            "dcmview: loaded {} DICOM file(s) from {} ({} skipped — not valid DICOM, {})",
            report.files.len(),
            path_label,
            report.skipped,
            recursive_note
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::collections::HashSet;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn bridge_launch_request_serializes_camel_case_contract() {
        let request = BridgeLaunchRequest {
            program: "dcmview".to_string(),
            args: vec!["scan.dcm".to_string()],
            cwd: "/workspace".to_string(),
            wait: false,
        };

        let value = serde_json::to_value(request).expect("bridge launch request serializes");

        assert_eq!(value["program"], "dcmview");
        assert_eq!(value["args"], serde_json::json!(["scan.dcm"]));
        assert_eq!(value["cwd"], "/workspace");
        assert_eq!(value["wait"], false);
    }

    #[test]
    fn launcher_cli_flags_exist_on_clap_contract() {
        let command = Cli::command();
        let flags = command
            .get_arguments()
            .filter_map(|argument| argument.get_long())
            .collect::<HashSet<_>>();
        let launcher_flags = launcher_long_flags();

        for expected in launcher_flags {
            assert!(
                flags.contains(expected.as_str()),
                "launcher-used CLI flag --{expected} must exist on Cli"
            );
        }
    }

    #[test]
    fn cli_definition_satisfies_clap_debug_assertions() {
        Cli::command().debug_assert();
    }

    fn launcher_long_flags() -> HashSet<String> {
        let mut flags = HashSet::new();
        collect_long_flags(include_str!("../python/dcmview_py/wrapper.py"), &mut flags);
        collect_long_flags(include_str!("../vscode/src/extension.ts"), &mut flags);
        flags
    }

    fn collect_long_flags(source: &str, flags: &mut HashSet<String>) {
        for segment in source.split("--").skip(1) {
            let flag = segment
                .chars()
                .take_while(|character| character.is_ascii_lowercase() || *character == '-')
                .collect::<String>();
            if !flag.is_empty() {
                flags.insert(flag);
            }
        }
    }

    #[test]
    fn bridge_launch_request_matches_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../docs/contracts/bridge-protocol.json"))
                .expect("bridge fixture parses");
        let request: BridgeLaunchRequest =
            serde_json::from_value(fixture["launch"]["request"].clone())
                .expect("launch request fixture parses");

        let value = serde_json::to_value(request).expect("bridge launch request serializes");

        assert_eq!(fixture["launch"]["method"], "POST");
        assert_eq!(fixture["launch"]["path"], "/launch");
        assert_eq!(value, fixture["launch"]["request"]);
    }

    #[test]
    fn bridge_responses_parse_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../docs/contracts/bridge-protocol.json"))
                .expect("bridge fixture parses");

        let launch: BridgeLaunchResponse =
            serde_json::from_value(fixture["launch"]["response"].clone())
                .expect("launch response fixture parses");
        let wait: BridgeWaitResponse = serde_json::from_value(fixture["wait"]["response"].clone())
            .expect("wait response fixture parses");

        assert_eq!(launch.session_id, "session-1");
        assert_eq!(launch.url, "http://127.0.0.1:51234");
        assert_eq!(wait.exit_code, Some(0));
    }

    #[test]
    fn bridge_wait_response_deserializes_camel_case_contract() {
        let response: BridgeWaitResponse =
            serde_json::from_str(r#"{"exitCode":7}"#).expect("bridge wait response parses");

        assert_eq!(response.exit_code, Some(7));
    }

    #[test]
    fn bridge_registry_endpoints_prefer_matching_workspace_then_newest() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let previous_registry_dir = env::var_os(VSCODE_BRIDGE_REGISTRY_DIR_ENV);
        let previous_url = env::var_os(VSCODE_BRIDGE_URL_ENV);
        let previous_token = env::var_os(VSCODE_BRIDGE_TOKEN_ENV);
        let previous_bypass = env::var_os(VSCODE_BRIDGE_BYPASS_ENV);
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let cwd = workspace.join("nested");
        fs::create_dir_all(&cwd).expect("workspace dirs");
        fs::write(temp.path().join("invalid.json"), "{").expect("invalid registry");
        fs::write(
            temp.path().join("old.json"),
            serde_json::json!({
                "version": 1,
                "instanceId": "old",
                "bridgeUrl": "http://127.0.0.1:1111",
                "token": "old-token",
                "workspaceRoots": [temp.path().join("elsewhere")],
                "createdAtMs": 999
            })
            .to_string(),
        )
        .expect("old registry");
        fs::write(
            temp.path().join("match.json"),
            serde_json::json!({
                "version": 1,
                "instanceId": "match",
                "bridgeUrl": "http://127.0.0.1:2222",
                "token": "match-token",
                "workspaceRoots": [workspace],
                "createdAtMs": 1
            })
            .to_string(),
        )
        .expect("matching registry");

        env::set_var(VSCODE_BRIDGE_REGISTRY_DIR_ENV, temp.path());
        env::remove_var(VSCODE_BRIDGE_URL_ENV);
        env::remove_var(VSCODE_BRIDGE_TOKEN_ENV);
        env::remove_var(VSCODE_BRIDGE_BYPASS_ENV);
        let endpoints = discover_vscode_bridge_endpoints(&cwd);
        restore_env(VSCODE_BRIDGE_REGISTRY_DIR_ENV, previous_registry_dir);
        restore_env(VSCODE_BRIDGE_URL_ENV, previous_url);
        restore_env(VSCODE_BRIDGE_TOKEN_ENV, previous_token);
        restore_env(VSCODE_BRIDGE_BYPASS_ENV, previous_bypass);

        assert_eq!(
            endpoints,
            vec![
                BridgeEndpoint {
                    url: "http://127.0.0.1:2222".to_string(),
                    token: "match-token".to_string(),
                },
                BridgeEndpoint {
                    url: "http://127.0.0.1:1111".to_string(),
                    token: "old-token".to_string(),
                },
            ]
        );
    }

    #[test]
    fn bridge_discovery_prefers_environment_and_honors_bypass() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let previous_registry_dir = env::var_os(VSCODE_BRIDGE_REGISTRY_DIR_ENV);
        let previous_url = env::var_os(VSCODE_BRIDGE_URL_ENV);
        let previous_token = env::var_os(VSCODE_BRIDGE_TOKEN_ENV);
        let previous_bypass = env::var_os(VSCODE_BRIDGE_BYPASS_ENV);
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join("registry.json"),
            serde_json::json!({
                "bridgeUrl": "http://127.0.0.1:1111",
                "token": "registry-token",
                "workspaceRoots": [],
                "createdAtMs": 1
            })
            .to_string(),
        )
        .expect("registry");

        env::set_var(VSCODE_BRIDGE_REGISTRY_DIR_ENV, temp.path());
        env::set_var(VSCODE_BRIDGE_URL_ENV, "http://127.0.0.1:2222");
        env::set_var(VSCODE_BRIDGE_TOKEN_ENV, "env-token");
        env::remove_var(VSCODE_BRIDGE_BYPASS_ENV);
        assert_eq!(
            discover_vscode_bridge_endpoints(temp.path()),
            vec![BridgeEndpoint {
                url: "http://127.0.0.1:2222".to_string(),
                token: "env-token".to_string(),
            }]
        );

        env::set_var(VSCODE_BRIDGE_BYPASS_ENV, "1");
        assert!(discover_vscode_bridge_endpoints(temp.path()).is_empty());

        restore_env(VSCODE_BRIDGE_REGISTRY_DIR_ENV, previous_registry_dir);
        restore_env(VSCODE_BRIDGE_URL_ENV, previous_url);
        restore_env(VSCODE_BRIDGE_TOKEN_ENV, previous_token);
        restore_env(VSCODE_BRIDGE_BYPASS_ENV, previous_bypass);
    }

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        match value {
            Some(value) => env::set_var(key, value),
            None => env::remove_var(key),
        }
    }
}
