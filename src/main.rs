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
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const VSCODE_BRIDGE_URL_ENV: &str = "DCMVIEW_VSCODE_BRIDGE_URL";
const VSCODE_BRIDGE_TOKEN_ENV: &str = "DCMVIEW_VSCODE_BRIDGE_TOKEN";
const VSCODE_BRIDGE_BYPASS_ENV: &str = "DCMVIEW_VSCODE_BYPASS";

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
        trailing_var_arg = true,
        allow_hyphen_values = true
    )]
    vscode_bridge_client: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
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
    let cli = Cli::parse();

    if let Some(bridge_args) = cli.vscode_bridge_client {
        return run_vscode_bridge_client(bridge_args).await;
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

    let bridge_url = match env::var(VSCODE_BRIDGE_URL_ENV) {
        Ok(value) if !value.is_empty() => value,
        _ => return fallback_to_local_viewer(args),
    };
    let token = match env::var(VSCODE_BRIDGE_TOKEN_ENV) {
        Ok(value) if !value.is_empty() => value,
        _ => return fallback_to_local_viewer(args),
    };

    let client = reqwest::Client::new();
    let launch = BridgeLaunchRequest {
        program: program.to_string(),
        args: args.to_vec(),
        cwd: env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .display()
            .to_string(),
        wait: false,
    };
    let launch_url = format!("{}/launch", bridge_url.trim_end_matches('/'));
    let response = client
        .post(launch_url)
        .bearer_auth(&token)
        .json(&launch)
        .send()
        .await;
    let launch_response = match response {
        Ok(response) if response.status().is_success() => {
            response.json::<BridgeLaunchResponse>().await?
        }
        Ok(response) => {
            eprintln!(
                "dcmview: VS Code bridge returned {}; falling back to local viewer",
                response.status()
            );
            return fallback_to_local_viewer(args);
        }
        Err(error) => {
            eprintln!(
                "dcmview: VS Code bridge unavailable ({error}); falling back to local viewer"
            );
            return fallback_to_local_viewer(args);
        }
    };

    println!("dcmview: opened in VS Code at {}", launch_response.url);
    let wait_url = format!(
        "{}/sessions/{}/wait",
        bridge_url.trim_end_matches('/'),
        launch_response.session_id
    );
    let stop_url = format!(
        "{}/sessions/{}/stop",
        bridge_url.trim_end_matches('/'),
        launch_response.session_id
    );

    tokio::select! {
        wait_result = wait_for_vscode_session(&client, &wait_url, &token) => wait_result,
        signal_result = tokio::signal::ctrl_c() => {
            signal_result.context("failed to listen for Ctrl+C")?;
            let _ = client.post(stop_url).bearer_auth(&token).send().await;
            Ok(130)
        }
    }
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
    fn bridge_wait_response_deserializes_camel_case_contract() {
        let response: BridgeWaitResponse =
            serde_json::from_str(r#"{"exitCode":7}"#).expect("bridge wait response parses");

        assert_eq!(response.exit_code, Some(7));
    }
}
