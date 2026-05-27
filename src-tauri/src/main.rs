#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use edge_tts_rust::{Boundary, EdgeTtsClient, SpeakOptions};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;
use std::{
    collections::VecDeque,
    env, fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command as StdCommand, Stdio},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, LogicalSize, Manager, WebviewWindow,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{process::Command as TokioCommand, time::sleep};
use uuid::Uuid;

const ACTIVE_SESSION_SCAN_MS: u64 = 5000;
const SESSION_POLL_MS: u64 = 500;
const MAX_QUEUE: usize = 3;
const MAX_SPEECH_CHARS: usize = 1800;
const SPEECH_CHUNK_TARGET_CHARS: usize = 760;
const SPEECH_CHUNK_MAX_CHARS: usize = 980;
const WINDOW_WIDTH: f64 = 430.0;
const WINDOW_HEIGHT: f64 = 132.0;
const SETTINGS_WINDOW_WIDTH: f64 = 520.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 320.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceInfo {
    id: String,
    label: String,
    locale: String,
    gender: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    engine: String,
    edge_voice: String,
    edge_pitch: i32,
    windows_voice_mode: String,
    windows_voice: String,
    speed: f64,
    volume: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            engine: "edge".into(),
            edge_voice: "en-US-AvaMultilingualNeural".into(),
            edge_pitch: 0,
            windows_voice_mode: "auto".into(),
            windows_voice: String::new(),
            speed: 1.05,
            volume: 0.85,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    state: String,
    title: String,
    detail: String,
    timestamp: String,
    metadata: Value,
}

#[derive(Clone)]
struct SessionState {
    id: String,
    name: String,
    cwd: String,
    source_path: PathBuf,
    attached_at: String,
    offset: u64,
    carry: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSession {
    id: String,
    name: String,
    cwd: String,
    source_path: String,
    attached_at: String,
}

#[derive(Clone)]
struct SpeechItem {
    text: String,
    force: bool,
    source: String,
    metadata: Value,
}

struct ReaderState {
    settings: Settings,
    windows_voices: Vec<VoiceInfo>,
    current_session: Option<SessionState>,
    current_usage: Option<Value>,
    current_activity: Activity,
    speech_queue: VecDeque<SpeechItem>,
    speech_busy: bool,
    current_playback_id: Option<String>,
    finished_playback_id: Option<String>,
    cancel_version: u64,
    skipped: usize,
    attach_in_flight: bool,
}

type SharedState = Arc<Mutex<ReaderState>>;

static WINDOWS_TTS_WORKER: LazyLock<Mutex<Option<WindowsTtsWorker>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicState {
    edge_voices: Vec<VoiceInfo>,
    windows_voices: Vec<VoiceInfo>,
    supported_engines: Vec<String>,
    settings: Settings,
    usage: Option<Value>,
    activity: Activity,
    session: Option<PublicSession>,
}

impl ReaderState {
    fn new() -> Self {
        Self {
            settings: Settings::default(),
            windows_voices: Vec::new(),
            current_session: None,
            current_usage: None,
            current_activity: activity("starting", "Launching QDex", "Starting up", json!({})),
            speech_queue: VecDeque::new(),
            speech_busy: false,
            current_playback_id: None,
            finished_playback_id: None,
            cancel_version: 0,
            skipped: 0,
            attach_in_flight: false,
        }
    }
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("{:?}", SystemTime::now()))
}

fn activity(state: &str, title: &str, detail: &str, metadata: Value) -> Activity {
    Activity {
        state: state.into(),
        title: title.into(),
        detail: detail.into(),
        timestamp: now(),
        metadata,
    }
}

fn emit_payload(app: &AppHandle, event: &str, payload: impl Serialize + Clone) {
    let _ = app.emit(event, payload);
}

fn status(app: &AppHandle, state: &str, message: &str) {
    emit_payload(
        app,
        "reader:status",
        json!({
            "state": state,
            "message": message,
            "timestamp": now()
        }),
    );
}

fn set_activity(app: &AppHandle, shared: &SharedState, next: Activity) {
    {
        let mut state = shared.lock().expect("reader state poisoned");
        state.current_activity = next.clone();
    }
    emit_payload(app, "reader:activity", next);
}

fn public_session(session: &SessionState) -> PublicSession {
    PublicSession {
        id: session.id.clone(),
        name: session.name.clone(),
        cwd: session.cwd.clone(),
        source_path: session.source_path.to_string_lossy().to_string(),
        attached_at: session.attached_at.clone(),
    }
}

fn public_state(state: &ReaderState) -> PublicState {
    PublicState {
        edge_voices: edge_voices(),
        windows_voices: state.windows_voices.clone(),
        supported_engines: vec!["edge".into(), "windows".into()],
        settings: state.settings.clone(),
        usage: state.current_usage.clone(),
        activity: state.current_activity.clone(),
        session: state.current_session.as_ref().map(public_session),
    }
}

fn shared_public_state(shared: &SharedState) -> PublicState {
    let state = shared.lock().expect("reader state poisoned");
    public_state(&state)
}

fn edge_voices() -> Vec<VoiceInfo> {
    [
        (
            "en-US-AvaMultilingualNeural",
            "Ava Multilingual",
            "en-US",
            "Female",
        ),
        ("en-US-JennyNeural", "Jenny", "en-US", "Female"),
        ("en-US-AriaNeural", "Aria", "en-US", "Female"),
        (
            "fr-FR-VivienneMultilingualNeural",
            "Vivienne Multilingual",
            "fr-FR",
            "Female",
        ),
        ("fr-FR-DeniseNeural", "Denise", "fr-FR", "Female"),
        ("fr-CA-SylvieNeural", "Sylvie", "fr-CA", "Female"),
        ("en-US-EmmaNeural", "Emma", "en-US", "Female"),
        ("en-GB-SoniaNeural", "Sonia", "en-GB", "Female"),
        (
            "en-US-AndrewMultilingualNeural",
            "Andrew Multilingual",
            "en-US",
            "Male",
        ),
        (
            "fr-FR-RemyMultilingualNeural",
            "Remy Multilingual",
            "fr-FR",
            "Male",
        ),
    ]
    .iter()
    .map(|(id, label, locale, gender)| VoiceInfo {
        id: (*id).into(),
        label: (*label).into(),
        locale: (*locale).into(),
        gender: (*gender).into(),
    })
    .collect()
}

fn clamp(value: f64, minimum: f64, maximum: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.max(minimum).min(maximum)
    } else {
        fallback
    }
}

fn value_string(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(|raw| {
            raw.as_str()
                .map(str::to_string)
                .or_else(|| raw.as_f64().map(|number| number.to_string()))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.into())
}

fn value_f64(value: &Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .and_then(|raw| raw.as_f64().or_else(|| raw.as_str()?.parse::<f64>().ok()))
        .unwrap_or(fallback)
}

fn value_i32(value: &Value, key: &str, fallback: i32) -> i32 {
    value_f64(value, key, f64::from(fallback)).round() as i32
}

fn normalize_settings(input: &Value, previous: &Settings, voices: &[VoiceInfo]) -> Settings {
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(previous.enabled);
    let windows_voice_mode =
        match value_string(input, "windowsVoiceMode", &previous.windows_voice_mode).as_str() {
            "manual" => "manual".to_string(),
            _ => "auto".to_string(),
        };
    let requested_windows_voice = value_string(input, "windowsVoice", &previous.windows_voice);
    let windows_voice = if voices
        .iter()
        .any(|voice| voice.id == requested_windows_voice)
    {
        requested_windows_voice
    } else {
        default_windows_voice(voices, "en")
    };

    let requested_engine = value_string(input, "engine", &previous.engine);
    let engine = match requested_engine.as_str() {
        "windows" => "windows".to_string(),
        _ => "edge".to_string(),
    };
    let requested_edge_voice = value_string(input, "edgeVoice", &previous.edge_voice);
    let edge_voice = if edge_voices()
        .iter()
        .any(|voice| voice.id == requested_edge_voice)
    {
        requested_edge_voice
    } else {
        "en-US-AvaMultilingualNeural".into()
    };

    Settings {
        enabled,
        engine,
        edge_voice,
        edge_pitch: value_i32(input, "edgePitch", previous.edge_pitch).clamp(-50, 50),
        windows_voice_mode,
        windows_voice,
        speed: clamp(value_f64(input, "speed", previous.speed), 0.7, 1.5, 1.05),
        volume: clamp(value_f64(input, "volume", previous.volume), 0.0, 1.0, 0.85),
    }
}

fn apply_speech_settings(shared: &SharedState, input: &Value) -> Settings {
    let mut state = shared.lock().expect("reader state poisoned");
    let next = normalize_settings(input, &state.settings, &state.windows_voices);
    state.settings = next.clone();
    next
}

fn codex_home() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn codex_sessions_root() -> PathBuf {
    env::var_os("QDEX_CODEX_SESSIONS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home().join(".codex").join("sessions"))
}

fn qdex_bridge_dir() -> PathBuf {
    env::var_os("QDEX_BRIDGE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home().join(".qdex"))
}

fn qdex_broadcast_path() -> PathBuf {
    env::var_os("QDEX_BROADCAST_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| qdex_bridge_dir().join("broadcast.jsonl"))
}

fn qdex_broadcast_enabled() -> bool {
    env::var("QDEX_BROADCAST_ENABLED")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(
                normalized.as_str(),
                "0" | "false" | "off" | "no" | "disabled"
            )
        })
        .unwrap_or(true)
}

fn append_bridge_broadcast(payload: &Value) {
    if !qdex_broadcast_enabled() {
        return;
    }

    let path = qdex_broadcast_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{payload}");
    }
}

fn collect_jsonl_files(directory: &Path, files: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_jsonl_files(&path, files);
        } else if metadata.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("jsonl"))
        {
            files.push((path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
        }
    }
}

fn newest_rollout_path() -> Result<PathBuf, String> {
    let mut files = Vec::new();
    collect_jsonl_files(&codex_sessions_root(), &mut files);
    files
        .into_iter()
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path)
        .ok_or_else(|| "No Codex rollout logs were found under ~/.codex/sessions.".into())
}

fn first_json_line(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(line.trim()).map_err(|error| error.to_string())
}

fn thread_name(thread_id: &str) -> String {
    let index_path = codex_home().join(".codex").join("session_index.jsonl");
    if let Ok(file) = fs::File::open(index_path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(row) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if row.get("id").and_then(Value::as_str) == Some(thread_id) {
                if let Some(name) = row.get("thread_name").and_then(Value::as_str) {
                    return name.to_string();
                }
            }
        }
    }
    format!("active-{}", thread_id.chars().take(8).collect::<String>())
}

fn epoch_milliseconds(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    Some(if number > 1_000_000_000_000.0 {
        number
    } else {
        number * 1000.0
    })
}

fn usage_from_row(row: &Value) -> Option<Value> {
    if row.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    let payload = row.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }

    let limits = payload.get("rate_limits")?;
    let primary = limits.get("primary")?;
    let used_percent = primary.get("used_percent")?.as_f64()?;
    let window_minutes = primary.get("window_minutes")?.as_f64()?;
    let reset_ms = epoch_milliseconds(primary.get("resets_at")?)?;
    let context_window = payload
        .pointer("/info/model_context_window")
        .and_then(Value::as_f64);
    let context_tokens = payload
        .pointer("/info/last_token_usage/total_tokens")
        .and_then(Value::as_f64);
    let context_used_percent = match (context_tokens, context_window) {
        (Some(tokens), Some(window)) if window > 0.0 => {
            Some((tokens / window * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };

    let timestamp = row
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now);

    Some(json!({
        "timestamp": timestamp,
        "limitId": limits.get("limit_id").and_then(Value::as_str).unwrap_or("codex"),
        "planType": limits.get("plan_type").and_then(Value::as_str).unwrap_or(""),
        "usedPercent": used_percent,
        "remainingPercent": (100.0 - used_percent).clamp(0.0, 100.0),
        "contextTokens": context_tokens,
        "contextUsedPercent": context_used_percent,
        "contextWindow": context_window,
        "windowMinutes": window_minutes,
        "resetsAt": primary.get("resets_at").cloned().unwrap_or(Value::Null),
        "resetAtIso": ps_date_from_epoch_ms(reset_ms),
        "secondaryUsedPercent": limits.pointer("/secondary/used_percent").and_then(Value::as_f64),
        "rateLimitReachedType": limits.get("rate_limit_reached_type").cloned().unwrap_or(Value::Null)
    }))
}

fn ps_date_from_epoch_ms(milliseconds: f64) -> String {
    match OffsetDateTime::from_unix_timestamp_nanos((milliseconds * 1_000_000.0).round() as i128) {
        Ok(date) => date.format(&Rfc3339).unwrap_or_else(|_| now()),
        Err(_) => now(),
    }
}

fn latest_usage_from_file(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut latest = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(usage) = usage_from_row(&row) {
            latest = Some(usage);
        }
    }
    latest
}

fn concise(value: &str, maximum: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.len() > maximum {
        format!("{}...", &clean[..maximum.saturating_sub(3)])
    } else {
        clean
    }
}

fn parse_arguments(value: &Value) -> Value {
    if value.is_object() {
        return value.clone();
    }
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}))
}

fn activity_for_tool_call(payload: &Value) -> Activity {
    let args = parse_arguments(payload.get("arguments").unwrap_or(&Value::Null));
    let namespace = payload
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("");
    let tool_name = payload.get("name").and_then(Value::as_str).unwrap_or("");
    let tool_id = if namespace.is_empty() {
        tool_name.to_string()
    } else {
        format!("{namespace}.{tool_name}")
    };
    let mut title = "Using tool";
    let mut detail = concise(&tool_id, 88);

    if tool_name == "shell_command" {
        title = "Running command";
        detail = concise(
            args.get("command")
                .and_then(Value::as_str)
                .unwrap_or("PowerShell command"),
            88,
        );
    } else if tool_name == "apply_patch" {
        title = "Editing files";
        detail = "Applying file changes".into();
    } else if tool_name == "update_plan" {
        title = "Updating plan";
        detail = "Refreshing the task checklist".into();
    }

    activity("working", title, &detail, json!({ "toolId": tool_id }))
}

fn activity_from_row(row: &Value) -> Option<Activity> {
    let kind = row.get("type").and_then(Value::as_str)?;
    let payload = row.get("payload").unwrap_or(&Value::Null);
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");

    if kind == "response_item" {
        return match payload_type {
            "reasoning" => Some(activity(
                "thinking",
                "Thinking",
                "Planning the next visible step",
                json!({}),
            )),
            "function_call" | "custom_tool_call" => Some(activity_for_tool_call(payload)),
            "function_call_output" | "custom_tool_call_output" => Some(activity(
                "working",
                "Reading tool output",
                "Tool returned output",
                json!({}),
            )),
            "message" => Some(activity(
                "replying",
                "Drafting reply",
                "Writing visible response",
                json!({}),
            )),
            _ => None,
        };
    }

    if kind != "event_msg" || payload_type == "token_count" {
        return None;
    }

    match payload_type {
        "agent_message" => Some(activity(
            "replying",
            "Updating you",
            "Sending a visible update",
            json!({}),
        )),
        "mcp_tool_call_begin" => Some(activity(
            "working",
            "Calling MCP tool",
            "MCP tool call started",
            json!({}),
        )),
        "mcp_tool_call_end" => Some(activity(
            "working",
            "Reading MCP output",
            "MCP tool finished",
            json!({}),
        )),
        "exec_command_begin" => Some(activity(
            "working",
            "Running command",
            &concise(
                payload
                    .get("command")
                    .or_else(|| payload.get("cmd"))
                    .and_then(Value::as_str)
                    .unwrap_or("command started"),
                88,
            ),
            json!({}),
        )),
        "exec_command_end" => Some(activity(
            if payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                == 0
            {
                "working"
            } else {
                "warning"
            },
            "Command finished",
            &format!(
                "Exit {}",
                payload
                    .get("exit_code")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1)
            ),
            json!({}),
        )),
        "patch_apply_begin" => Some(activity(
            "working",
            "Editing files",
            "Applying patch",
            json!({}),
        )),
        "patch_apply_end" => Some(activity(
            "working",
            "Patch applied",
            "File changes saved",
            json!({}),
        )),
        "user_message" => Some(activity(
            "input",
            "User prompt received",
            "New request in active session",
            json!({}),
        )),
        "error" => Some(activity(
            "error",
            "Codex error",
            &concise(
                payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("error"),
                88,
            ),
            json!({}),
        )),
        _ => Some(activity(
            "working",
            "Codex activity",
            &concise(payload_type, 88),
            json!({}),
        )),
    }
}

fn visible_codex_output(row: &Value) -> Option<Value> {
    if row.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    let payload = row.get("payload")?;
    if payload.get("type")?.as_str()? != "agent_message" {
        return None;
    }
    let text = payload.get("message")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let timestamp = row
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now);

    Some(json!({
        "id": Uuid::new_v4().to_string(),
        "timestamp": timestamp,
        "text": text,
        "phase": payload.get("phase").and_then(Value::as_str).unwrap_or("")
    }))
}

async fn attach_active_internal(
    app: &AppHandle,
    shared: &SharedState,
    source_path: Option<PathBuf>,
    reason: &str,
    quiet: bool,
) -> Result<Option<PublicSession>, String> {
    let source_path = match source_path {
        Some(path) => path,
        None => newest_rollout_path()?,
    };

    if let Some(existing) = {
        let state = shared.lock().expect("reader state poisoned");
        state.current_session.clone()
    } {
        if existing.source_path == source_path {
            if !quiet {
                let usage = latest_usage_from_file(&source_path);
                {
                    let mut state = shared.lock().expect("reader state poisoned");
                    state.current_usage = usage.clone();
                }
                emit_payload(app, "reader:usage", usage);
                status(
                    app,
                    "ready",
                    &format!("Still listening to {}.", existing.name),
                );
            }
            return Ok(Some(public_session(&existing)));
        }
    }

    let meta = first_json_line(&source_path)?;
    let stat = fs::metadata(&source_path).map_err(|error| error.to_string())?;
    let id = meta
        .pointer("/payload/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let cwd = meta
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session = SessionState {
        name: thread_name(&id),
        id,
        cwd,
        source_path: source_path.clone(),
        attached_at: now(),
        offset: stat.len(),
        carry: String::new(),
    };
    let public = public_session(&session);
    let usage = latest_usage_from_file(&source_path);
    {
        let mut state = shared.lock().expect("reader state poisoned");
        state.current_session = Some(session);
        state.current_usage = usage.clone();
    }

    emit_payload(app, "reader:session", public.clone());
    emit_payload(app, "reader:usage", usage);
    set_activity(
        app,
        shared,
        activity(
            "session",
            if reason == "auto" {
                "Switched session"
            } else {
                "Monitoring session"
            },
            &public.name,
            json!({}),
        ),
    );
    let ready_message = if reason == "auto" {
        format!("Auto-attached to {}.", public.name)
    } else {
        format!(
            "Listening for new visible Codex output from {}.",
            public.name
        )
    };
    status(app, "ready", &ready_message);
    Ok(Some(public))
}

async fn auto_attach_active(app: &AppHandle, shared: &SharedState) {
    {
        let mut state = shared.lock().expect("reader state poisoned");
        if state.attach_in_flight {
            return;
        }
        state.attach_in_flight = true;
    }

    let result = newest_rollout_path().and_then(|path| {
        let current = shared
            .lock()
            .expect("reader state poisoned")
            .current_session
            .as_ref()
            .map(|session| session.source_path.clone());
        if current.as_ref() == Some(&path) {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    });

    match result {
        Ok(Some(path)) => {
            let _ = attach_active_internal(app, shared, Some(path), "auto", true).await;
        }
        Err(error) => {
            let has_session = shared
                .lock()
                .expect("reader state poisoned")
                .current_session
                .is_some();
            if !has_session {
                status(app, "warning", &error);
            }
        }
        Ok(None) => {}
    }

    shared
        .lock()
        .expect("reader state poisoned")
        .attach_in_flight = false;
}

async fn read_added_lines(app: &AppHandle, shared: &SharedState) {
    let session = {
        let state = shared.lock().expect("reader state poisoned");
        state.current_session.clone()
    };
    let Some(mut session) = session else {
        return;
    };

    let Ok(stat) = fs::metadata(&session.source_path) else {
        status(app, "error", "Could not read the Codex output log.");
        return;
    };
    if stat.len() < session.offset {
        session.offset = 0;
        session.carry.clear();
    }
    if stat.len() == session.offset {
        return;
    }

    let length = stat.len() - session.offset;
    let mut file = match fs::File::open(&session.source_path) {
        Ok(file) => file,
        Err(error) => {
            status(
                app,
                "error",
                &format!("Could not open the Codex output log: {error}"),
            );
            return;
        }
    };
    if file.seek(SeekFrom::Start(session.offset)).is_err() {
        return;
    }
    let mut buffer = vec![0; length as usize];
    if file.read_exact(&mut buffer).is_err() {
        return;
    }
    session.offset = stat.len();

    let mut content = session.carry.clone();
    content.push_str(&String::from_utf8_lossy(&buffer));
    let mut lines = content.split('\n').map(str::to_string).collect::<Vec<_>>();
    session.carry = lines.pop().unwrap_or_default();

    for line in lines {
        let clean = line.trim().trim_start_matches('\u{feff}');
        if clean.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(clean) else {
            continue;
        };
        if let Some(next_activity) = activity_from_row(&row) {
            set_activity(app, shared, next_activity);
        }
        if let Some(usage) = usage_from_row(&row) {
            {
                let mut state = shared.lock().expect("reader state poisoned");
                state.current_usage = Some(usage.clone());
            }
            emit_payload(app, "reader:usage", Some(usage));
        }
        if let Some(output) = visible_codex_output(&row) {
            emit_payload(app, "reader:output", output.clone());
            append_bridge_broadcast(&json!({
                "type": "output",
                "source": "codex-log",
                "createdAt": now(),
                "output": output
            }));
            if let Some(text) = output.get("text").and_then(Value::as_str) {
                queue_output(app, shared, text.to_string(), false);
            }
        }
    }

    let mut state = shared.lock().expect("reader state poisoned");
    if state
        .current_session
        .as_ref()
        .is_some_and(|current| current.source_path == session.source_path)
    {
        state.current_session = Some(session);
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SpeechLang {
    Fr,
    En,
}

fn speech_lang_from_code(code: &str) -> SpeechLang {
    if code.eq_ignore_ascii_case("fr") {
        SpeechLang::Fr
    } else {
        SpeechLang::En
    }
}

fn lang_pair(lang: SpeechLang, fr: &'static str, en: &'static str) -> &'static str {
    match lang {
        SpeechLang::Fr => fr,
        SpeechLang::En => en,
    }
}

static MARKDOWN_IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]+\)").expect("valid image regex"));
static MARKDOWN_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").expect("valid link regex"));
static DIRECTIVE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"::[A-Za-z0-9_-]+\{[^}]*\}").expect("valid directive regex"));
static INLINE_CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`[^`]+`").expect("valid inline code regex"));
static MARKDOWN_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s{0,3}#{1,6}\s+").expect("valid heading regex"));
static MARKDOWN_QUOTE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s{0,3}>\s?").expect("valid quote regex"));
static MARKDOWN_BULLET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)").expect("valid bullet regex"));
static MARKDOWN_EMPHASIS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*{1,3}([^*\n]+?)\*{1,3}").expect("valid emphasis regex"));
static MARKDOWN_UNDERSCORE_STRONG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"__([^_\n]+?)__").expect("valid underscore emphasis regex"));
static MARKDOWN_MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[*_]{1,3}").expect("valid marker regex"));
static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s<>"'`)}\]]+"#).expect("valid url regex"));
static LOCALHOST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\blocalhost(?::\d{2,5})?\b").expect("valid host regex"));
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
        .expect("valid uuid regex")
});
static IP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").expect("valid ip regex"));
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:v\d+\.\d+(?:\.\d+)?|\d+\.\d+\.\d+)(?:-[a-z0-9.-]+)?\b")
        .expect("valid version regex")
});
static WINDOWS_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:[a-z]:\\|%[a-z0-9_]+%\\|~\\)[^\s<>"'`)}\]]+"#)
        .expect("valid windows path regex")
});
static ABSOLUTE_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(^|\s)(/[\w.@{}:-]+(?:/[\w.@{}:-]+)+(?:\.[a-z0-9]+)?(?::\d+)?)"#)
        .expect("valid absolute path regex")
});
static RELATIVE_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(^|\s)((?:\.{1,2}[\\/]|[A-Za-z0-9_.@-]+[\\/])[A-Za-z0-9_./\\ @{}:-]+(?::\d+)?)"#,
    )
    .expect("valid relative path regex")
});
static FILENAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r##"(?i)(^|[\s\(\[\{"'])([a-z0-9_@-]+(?:\.[a-z0-9_-]+)+(?::\d+)?|\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?::\d+)?)"##)
        .expect("valid filename regex")
});
static HEX_HASH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{7,40}\b").expect("valid hash regex"));
static TECH_WORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|sql|csv|tsv|svg|api|cli|sdk|ide|orm|ast|dom|http|https|rest|graphql|crud|uuid|guid|jwt|oauth|cors|dns|tcp|udp|ip|ssh|ssl|tls|llm|gpt|rag|mcp|npm|pnpm|ci|cd|pr|mr|repo|postgresql|mysql|sqlite|mongodb|redis)\b",
    )
    .expect("valid technical word regex")
});
static ACRONYM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Z][A-Z0-9]{1,9}\b").expect("valid acronym regex"));
static CAMEL_LOWER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").expect("valid camel regex"));
static CAMEL_UPPER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Z])([A-Z][a-z])").expect("valid camel regex"));
static COMMAND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(npm|pnpm|yarn|bun)\s+(install|run|start|build|dev|test|add|remove|update)\b",
    )
    .expect("valid command regex")
});
static GIT_COMMAND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bgit\s+(status|add|commit|push|pull|checkout|switch|merge|rebase|clone|diff|log|branch)\b")
        .expect("valid git regex")
});
static FLAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|\s)(--?[A-Za-z][\w-]*)").expect("valid flag regex"));
static CODE_SYMBOL_RULES: LazyLock<Vec<(Regex, &'static str, &'static str)>> =
    LazyLock::new(|| {
        vec![
            (
                Regex::new(r"!==").unwrap(),
                " strictement different ",
                " strictly not equal ",
            ),
            (
                Regex::new(r"===").unwrap(),
                " strictement egal ",
                " strictly equals ",
            ),
            (Regex::new(r"=>").unwrap(), " fleche ", " arrow "),
            (Regex::new(r"->").unwrap(), " fleche ", " arrow "),
            (
                Regex::new(r"\?\.").unwrap(),
                " chainage optionnel ",
                " optional chaining ",
            ),
            (
                Regex::new(r"\?\?").unwrap(),
                " coalescence nulle ",
                " nullish coalescing ",
            ),
            (
                Regex::new(r"\.\.\.").unwrap(),
                " trois points ",
                " dot dot dot ",
            ),
            (Regex::new(r"&&").unwrap(), " et logique ", " logical and "),
            (Regex::new(r"\|\|").unwrap(), " ou logique ", " logical or "),
            (Regex::new(r"==").unwrap(), " egal egal ", " double equals "),
            (Regex::new(r"!=").unwrap(), " different ", " not equal "),
            (
                Regex::new(r"<=").unwrap(),
                " inferieur ou egal ",
                " less or equal ",
            ),
            (
                Regex::new(r">=").unwrap(),
                " superieur ou egal ",
                " greater or equal ",
            ),
            (
                Regex::new(r"::").unwrap(),
                " double deux-points ",
                " double colon ",
            ),
        ]
    });
static SINGLE_CODE_SYMBOL_RULES: LazyLock<Vec<(Regex, &'static str, &'static str)>> =
    LazyLock::new(|| {
        vec![
            (
                Regex::new(r"\(").unwrap(),
                " parenthese ouvrante ",
                " open parenthesis ",
            ),
            (
                Regex::new(r"\)").unwrap(),
                " parenthese fermante ",
                " close parenthesis ",
            ),
            (
                Regex::new(r"\[").unwrap(),
                " crochet ouvrant ",
                " open bracket ",
            ),
            (
                Regex::new(r"\]").unwrap(),
                " crochet fermant ",
                " close bracket ",
            ),
            (
                Regex::new(r"\{").unwrap(),
                " accolade ouvrante ",
                " open brace ",
            ),
            (
                Regex::new(r"\}").unwrap(),
                " accolade fermante ",
                " close brace ",
            ),
            (Regex::new(r"<").unwrap(), " inferieur a ", " less than "),
            (Regex::new(r">").unwrap(), " superieur a ", " greater than "),
            (Regex::new(r";").unwrap(), " point-virgule ", " semicolon "),
            (Regex::new(r":").unwrap(), " deux-points ", " colon "),
            (Regex::new(r",").unwrap(), " virgule ", " comma "),
            (Regex::new(r"\+").unwrap(), " plus ", " plus "),
            (Regex::new(r"\*").unwrap(), " etoile ", " star "),
            (Regex::new(r"\|").unwrap(), " pipe ", " pipe "),
            (Regex::new(r"!").unwrap(), " non ", " not "),
            (Regex::new(r"`").unwrap(), " backtick ", " backtick "),
        ]
    });
static MULTISPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("valid whitespace regex"));

fn spell_token(token: &str) -> String {
    token
        .chars()
        .map(|character| character.to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_camel_case(value: &str) -> String {
    let clean = CAMEL_LOWER_RE.replace_all(value, "$1 $2").into_owned();
    CAMEL_UPPER_RE.replace_all(&clean, "$1 $2").into_owned()
}

fn split_line_suffix(token: &str) -> (&str, Option<&str>) {
    if let Some((head, tail)) = token.rsplit_once(':') {
        if !head.is_empty() && tail.chars().all(|character| character.is_ascii_digit()) {
            return (head, Some(tail));
        }
    }
    (token, None)
}

fn regex_matches_full(regex: &Regex, token: &str) -> bool {
    regex
        .find(token)
        .is_some_and(|match_| match_.start() == 0 && match_.end() == token.len())
}

fn is_hex_hash_token(token: &str) -> bool {
    (7..=40).contains(&token.len())
        && token.chars().all(|character| character.is_ascii_hexdigit())
        && token
            .chars()
            .any(|character| matches!(character, 'a'..='f' | 'A'..='F'))
}

fn spoken_line_suffix(line: Option<&str>, lang: SpeechLang) -> String {
    line.map(|line| format!(" {} {}", lang_pair(lang, "ligne", "line"), line))
        .unwrap_or_default()
}

fn env_suffix_word(value: &str, lang: SpeechLang) -> String {
    match (lang, value.to_ascii_lowercase().as_str()) {
        (SpeechLang::Fr, "example") => "exemple".into(),
        (SpeechLang::Fr, "development") => "developpement".into(),
        (SpeechLang::Fr, "staging") => "preproduction".into(),
        (_, "prod") => "production".into(),
        (_, "dev") => "development".into(),
        _ => normalize_identifier_segment(value, lang),
    }
}

fn spoken_environment_file(token: &str, lang: SpeechLang) -> Option<String> {
    let (core, line) = split_line_suffix(token);
    let lower = core.to_ascii_lowercase();
    if lower != ".env" && !lower.starts_with(".env.") {
        return None;
    }

    let suffix = core
        .strip_prefix(".env.")
        .map(|suffix| {
            suffix
                .split('.')
                .filter(|part| !part.is_empty())
                .map(|part| env_suffix_word(part, lang))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let base = match (lang, suffix.is_empty()) {
        (SpeechLang::Fr, true) => "fichier d'environnement".to_string(),
        (SpeechLang::Fr, false) => {
            format!("fichier d'environnement {}", suffix.join(" "))
        }
        (SpeechLang::En, true) => "environment file".to_string(),
        (SpeechLang::En, false) => format!("{} environment file", suffix.join(" ")),
    };

    Some(format!("{base}{}", spoken_line_suffix(line, lang)))
}

fn spoken_known_word(word: &str, lang: SpeechLang) -> Option<&'static str> {
    match word.to_ascii_uppercase().as_str() {
        "JSON" => Some(lang_pair(lang, "jison", "jason")),
        "JSONL" => Some(lang_pair(lang, "jison L", "jason L")),
        "YAML" | "YML" => Some("yamel"),
        "XML" => Some("X M L"),
        "HTML" => Some("H T M L"),
        "CSS" => Some("C S S"),
        "JS" => Some("JavaScript"),
        "JSX" => Some("J S X"),
        "TS" => Some("TypeScript"),
        "TSX" => Some("T S X"),
        "SQL" => Some(lang_pair(lang, "S Q L", "sequel")),
        "CSV" => Some("C S V"),
        "TSV" => Some("T S V"),
        "SVG" => Some("S V G"),
        "API" => Some("A P I"),
        "CLI" => Some("C L I"),
        "SDK" => Some("S D K"),
        "IDE" => Some("I D E"),
        "ORM" => Some("O R M"),
        "AST" => Some("A S T"),
        "DOM" => Some("D O M"),
        "HTTP" => Some("H T T P"),
        "HTTPS" => Some("H T T P S"),
        "REST" => Some(lang_pair(lang, "reste", "rest")),
        "GRAPHQL" => Some("Graph Q L"),
        "CRUD" => Some(lang_pair(lang, "crude", "crud")),
        "UUID" => Some("U U I D"),
        "GUID" => Some("G U I D"),
        "JWT" => Some("J W T"),
        "OAUTH" => Some("O Auth"),
        "CORS" => Some("CORS"),
        "DNS" => Some("D N S"),
        "TCP" => Some("T C P"),
        "UDP" => Some("U D P"),
        "IP" => Some("I P"),
        "SSH" => Some("S S H"),
        "SSL" => Some("S S L"),
        "TLS" => Some("T L S"),
        "LLM" => Some("L L M"),
        "GPT" => Some("G P T"),
        "RAG" => Some("R A G"),
        "MCP" => Some("M C P"),
        "NPM" => Some("N P M"),
        "PNPM" => Some("P N P M"),
        "CI" => Some("C I"),
        "CD" => Some("C D"),
        "PR" => Some("pull request"),
        "MR" => Some("merge request"),
        "REPO" => Some(lang_pair(lang, "depot", "repo")),
        "POSTGRESQL" => Some("postgres Q L"),
        "MYSQL" => Some("My S Q L"),
        "SQLITE" => Some("S Q Lite"),
        "MONGODB" => Some("Mongo D B"),
        "REDIS" => Some("Redis"),
        _ => None,
    }
}

fn spoken_extension(extension: &str, lang: SpeechLang) -> Option<String> {
    let dot = lang_pair(lang, "point", "dot");
    let spoken = match extension.to_ascii_lowercase().as_str() {
        "json" => lang_pair(lang, "point jison", "dot jason"),
        "jsonl" => lang_pair(lang, "point jison L", "dot jason L"),
        "js" => lang_pair(lang, "point JavaScript", "dot JavaScript"),
        "mjs" => lang_pair(lang, "point module JavaScript", "dot module JavaScript"),
        "cjs" => lang_pair(lang, "point Common J S", "dot Common J S"),
        "jsx" => lang_pair(lang, "point J S X", "dot J S X"),
        "ts" => lang_pair(lang, "point TypeScript", "dot TypeScript"),
        "tsx" => lang_pair(lang, "point T S X", "dot T S X"),
        "html" | "htm" => lang_pair(lang, "point H T M L", "dot H T M L"),
        "css" => lang_pair(lang, "point C S S", "dot C S S"),
        "scss" => lang_pair(lang, "point S C S S", "dot S C S S"),
        "sass" => lang_pair(lang, "point Sass", "dot Sass"),
        "less" => lang_pair(lang, "point Less", "dot Less"),
        "vue" => lang_pair(lang, "point Vue", "dot Vue"),
        "svelte" => lang_pair(lang, "point Svelte", "dot Svelte"),
        "py" => lang_pair(lang, "point Python", "dot Python"),
        "pyc" => lang_pair(lang, "point P Y C", "dot P Y C"),
        "cpp" => lang_pair(lang, "point C plus plus", "dot C plus plus"),
        "cc" => lang_pair(lang, "point C C", "dot C C"),
        "cxx" => lang_pair(lang, "point C X X", "dot C X X"),
        "c" => lang_pair(lang, "point C", "dot C"),
        "h" => lang_pair(lang, "point header", "dot H"),
        "hpp" => lang_pair(lang, "point H P P", "dot H P P"),
        "cs" => lang_pair(lang, "point C sharp", "dot C sharp"),
        "java" => lang_pair(lang, "point Java", "dot Java"),
        "kt" => lang_pair(lang, "point Kotlin", "dot Kotlin"),
        "kts" => lang_pair(lang, "point Kotlin script", "dot Kotlin script"),
        "go" => lang_pair(lang, "point Go", "dot Go"),
        "rs" => lang_pair(lang, "point Rust", "dot Rust"),
        "php" => lang_pair(lang, "point P H P", "dot P H P"),
        "rb" => lang_pair(lang, "point Ruby", "dot Ruby"),
        "swift" => lang_pair(lang, "point Swift", "dot Swift"),
        "dart" => lang_pair(lang, "point Dart", "dot Dart"),
        "sql" => lang_pair(lang, "point S Q L", "dot sequel"),
        "db" => lang_pair(lang, "point database", "dot D B"),
        "sqlite" => lang_pair(lang, "point SQLite", "dot SQLite"),
        "xml" => lang_pair(lang, "point X M L", "dot X M L"),
        "yaml" | "yml" => lang_pair(lang, "point yamel", "dot yamel"),
        "toml" => lang_pair(lang, "point tomel", "dot tomel"),
        "ini" => lang_pair(lang, "point I N I", "dot I N I"),
        "env" => lang_pair(lang, "point env", "dot env"),
        "md" => lang_pair(lang, "point Markdown", "dot Markdown"),
        "mdx" => lang_pair(lang, "point M D X", "dot M D X"),
        "txt" => lang_pair(lang, "point texte", "dot text"),
        "log" => lang_pair(lang, "point log", "dot log"),
        "lock" => lang_pair(lang, "point lock", "dot lock"),
        "sh" => lang_pair(lang, "point shell", "dot shell"),
        "bash" => lang_pair(lang, "point bash", "dot bash"),
        "zsh" => lang_pair(lang, "point Z shell", "dot Z shell"),
        "ps1" => lang_pair(lang, "point PowerShell", "dot PowerShell"),
        "bat" => lang_pair(lang, "point batch", "dot batch"),
        "cmd" => lang_pair(lang, "point commande", "dot command"),
        "dockerfile" => lang_pair(lang, "point Dockerfile", "dot Dockerfile"),
        "gitignore" => lang_pair(lang, "point git ignore", "dot git ignore"),
        "npmrc" => lang_pair(lang, "point N P M R C", "dot N P M R C"),
        "prettierrc" => lang_pair(lang, "point prettier R C", "dot prettier R C"),
        "eslintrc" => lang_pair(lang, "point E S lint R C", "dot E S lint R C"),
        "svg" => lang_pair(lang, "point S V G", "dot S V G"),
        "png" => lang_pair(lang, "point P N G", "dot P N G"),
        "jpg" => lang_pair(lang, "point J P G", "dot J P G"),
        "jpeg" => lang_pair(lang, "point J PEG", "dot J peg"),
        "webp" => lang_pair(lang, "point Web P", "dot Web P"),
        "gif" => lang_pair(lang, "point gif", "dot gif"),
        "ico" => lang_pair(lang, "point icone", "dot icon"),
        "pdf" => lang_pair(lang, "point P D F", "dot P D F"),
        "zip" => lang_pair(lang, "point zip", "dot zip"),
        "tar" => lang_pair(lang, "point tar", "dot tar"),
        "gz" => lang_pair(lang, "point G Z", "dot G Z"),
        "rar" => lang_pair(lang, "point rar", "dot rar"),
        "7z" => lang_pair(lang, "point sept zip", "dot seven zip"),
        _ if !extension.is_empty() => return Some(format!("{dot} {}", spell_token(extension))),
        _ => return None,
    };
    Some(spoken.to_string())
}

fn spoken_known_filename(core: &str, line: Option<&str>, lang: SpeechLang) -> Option<String> {
    let spoken = match core.to_ascii_lowercase().as_str() {
        "readme" => "read me",
        "agent" | "agents" => lang_pair(lang, "agent", "agent"),
        "license" | "licence" => lang_pair(lang, "licence", "license"),
        "changelog" => "change log",
        "todo" => lang_pair(lang, "a faire", "to do"),
        _ => return None,
    };
    Some(format!("{spoken}{}", spoken_line_suffix(line, lang)))
}

fn known_filename_with_extension(
    stem: &str,
    extension: &str,
    line: Option<&str>,
    lang: SpeechLang,
) -> Option<String> {
    let known = spoken_known_filename(stem, None, lang)?;
    let extension = spoken_extension(extension, lang).unwrap_or_default();
    Some(
        format!(
            "{}{}{}{}",
            known,
            if extension.is_empty() { "" } else { " " },
            extension,
            spoken_line_suffix(line, lang)
        )
        .trim()
        .to_string(),
    )
}

fn normalize_identifier_segment(value: &str, lang: SpeechLang) -> String {
    let trimmed = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('`');
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(rest) = trimmed.strip_prefix(':') {
        return format!(
            "{} {}",
            lang_pair(lang, "parametre", "parameter"),
            normalize_identifier_segment(rest, lang)
        );
    }
    if trimmed.starts_with('{') && trimmed.ends_with('}') && trimmed.len() > 2 {
        return format!(
            "{} {}",
            lang_pair(lang, "parametre", "parameter"),
            normalize_identifier_segment(&trimmed[1..trimmed.len() - 1], lang)
        );
    }
    if let Some(word) = spoken_known_word(trimmed, lang) {
        return word.to_string();
    }

    let mut clean = split_camel_case(trimmed);
    clean = clean
        .replace('@', lang_pair(lang, " arobase ", " at "))
        .replace('#', lang_pair(lang, " diese ", " hash "))
        .replace('$', lang_pair(lang, " dollar ", " dollar "))
        .replace('_', " underscore ")
        .replace('-', lang_pair(lang, " tiret ", " dash "));
    clean = ACRONYM_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            spoken_known_word(token, lang)
                .map(str::to_string)
                .unwrap_or_else(|| spell_token(token))
        })
        .into_owned();
    clean = TECH_WORD_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            spoken_known_word(token, lang).unwrap_or(token).to_string()
        })
        .into_owned();
    MULTISPACE_RE.replace_all(&clean, " ").trim().to_string()
}

fn normalize_filename_token(token: &str, lang: SpeechLang) -> String {
    if let Some(spoken) = spoken_environment_file(token, lang) {
        return spoken;
    }

    let (core, line) = split_line_suffix(token);
    if let Some((stem, extension)) = core.rsplit_once('.') {
        let stem = stem.trim_start_matches('.');
        if let Some(known) = known_filename_with_extension(stem, extension, line, lang) {
            return known;
        }
        let mut parts = Vec::new();
        if !stem.is_empty() {
            parts.push(normalize_identifier_segment(stem, lang));
        }
        if let Some(extension) = spoken_extension(extension, lang) {
            parts.push(extension);
        }
        return format!(
            "{}{}",
            MULTISPACE_RE.replace_all(&parts.join(" "), " ").trim(),
            spoken_line_suffix(line, lang)
        );
    }

    if let Some(known) = spoken_known_filename(core, line, lang) {
        return known;
    }

    format!(
        "{}{}",
        normalize_identifier_segment(core, lang),
        spoken_line_suffix(line, lang)
    )
}

fn last_path_segment(value: &str) -> &str {
    let trimmed = value.trim_end_matches(|character| character == '/' || character == '\\');
    trimmed
        .rsplit(|character| character == '/' || character == '\\')
        .find(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
}

fn normalize_path_token(token: &str, lang: SpeechLang) -> String {
    let (core, line) = split_line_suffix(token);
    let segment = last_path_segment(core);
    let normalized = if segment.contains('.') {
        normalize_filename_token(segment, lang)
    } else {
        normalize_technical_token(segment, lang)
    };

    format!(
        "{}{}",
        MULTISPACE_RE.replace_all(&normalized, " ").trim(),
        spoken_line_suffix(line, lang)
    )
}

fn normalize_url_token(token: &str, lang: SpeechLang) -> String {
    let mut clean = token
        .trim_end_matches(|character| matches!(character, '.' | ',' | ';' | ')' | ']'))
        .to_string();
    clean = clean
        .replace("https://", "H T T P S : / / ")
        .replace("http://", "H T T P : / / ")
        .replace("HTTPS://", "H T T P S : / / ")
        .replace("HTTP://", "H T T P : / / ");
    clean = clean
        .replace("%20", lang_pair(lang, " espace encode ", " encoded space "))
        .replace(
            "www.",
            &format!("W W W {} ", lang_pair(lang, "point", "dot")),
        )
        .replace('/', " slash ")
        .replace('\\', lang_pair(lang, " antislash ", " backslash "))
        .replace('.', lang_pair(lang, " point ", " dot "))
        .replace(':', lang_pair(lang, " deux-points ", " colon "))
        .replace(
            '?',
            lang_pair(lang, " point d'interrogation ", " question mark "),
        )
        .replace('&', lang_pair(lang, " et commercial ", " ampersand "))
        .replace('=', lang_pair(lang, " egal ", " equals "))
        .replace('#', lang_pair(lang, " diese ", " hash "));
    MULTISPACE_RE.replace_all(&clean, " ").trim().to_string()
}

fn normalize_version_token(token: &str, lang: SpeechLang) -> String {
    let mut clean = token.to_string();
    if clean.to_ascii_lowercase().starts_with('v') {
        clean.replace_range(0..1, "version ");
    } else {
        clean.insert_str(0, "version ");
    }
    clean = clean
        .replace('.', lang_pair(lang, " point ", " dot "))
        .replace('-', lang_pair(lang, " tiret ", " dash "));
    MULTISPACE_RE.replace_all(&clean, " ").trim().to_string()
}

fn normalize_ip_token(token: &str, lang: SpeechLang) -> String {
    token
        .split('.')
        .collect::<Vec<_>>()
        .join(lang_pair(lang, " point ", " dot "))
}

fn normalize_hash_token(token: &str) -> String {
    format!("hash {}", spell_token(token))
}

fn normalize_localhost_token(token: &str, lang: SpeechLang) -> String {
    if let Some((host, port)) = token.split_once(':') {
        format!("{} {} {}", host, lang_pair(lang, "port", "port"), port)
    } else {
        token.to_string()
    }
}

fn normalize_technical_token(token: &str, lang: SpeechLang) -> String {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if regex_matches_full(&UUID_RE, trimmed) {
        return lang_pair(lang, "identifiant U U I D", "U U I D identifier").to_string();
    }
    if is_hex_hash_token(trimmed) {
        return normalize_hash_token(trimmed);
    }
    if regex_matches_full(&IP_RE, trimmed) {
        return normalize_ip_token(trimmed, lang);
    }
    if regex_matches_full(&VERSION_RE, trimmed) {
        return normalize_version_token(trimmed, lang);
    }
    if let Some(spoken) = spoken_environment_file(trimmed, lang) {
        return spoken;
    }
    if trimmed.to_ascii_lowercase().starts_with("http://")
        || trimmed.to_ascii_lowercase().starts_with("https://")
    {
        return normalize_url_token(trimmed, lang);
    }
    if regex_matches_full(&LOCALHOST_RE, trimmed) {
        return normalize_localhost_token(trimmed, lang);
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return normalize_path_token(trimmed, lang);
    }
    if trimmed.contains('.') {
        return normalize_filename_token(trimmed, lang);
    }
    normalize_identifier_segment(trimmed, lang)
}

fn normalize_code_symbols(
    mut text: String,
    lang: SpeechLang,
    include_single_symbols: bool,
) -> String {
    for (regex, fr, en) in CODE_SYMBOL_RULES.iter() {
        text = regex
            .replace_all(&text, lang_pair(lang, fr, en))
            .into_owned();
    }
    if include_single_symbols {
        for (regex, fr, en) in SINGLE_CODE_SYMBOL_RULES.iter() {
            text = regex
                .replace_all(&text, lang_pair(lang, fr, en))
                .into_owned();
        }
    }
    text
}

fn normalize_speech_fragment(text: &str, lang: SpeechLang, include_single_symbols: bool) -> String {
    let mut clean = text.to_string();

    clean = URL_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            normalize_url_token(token, lang)
        })
        .into_owned();
    clean = LOCALHOST_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            normalize_localhost_token(token, lang)
        })
        .into_owned();
    clean = UUID_RE
        .replace_all(
            &clean,
            lang_pair(lang, "identifiant U U I D", "U U I D identifier"),
        )
        .into_owned();
    clean = IP_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            normalize_ip_token(token, lang)
        })
        .into_owned();
    clean = VERSION_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            normalize_version_token(token, lang)
        })
        .into_owned();
    clean = WINDOWS_PATH_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            normalize_path_token(token, lang)
        })
        .into_owned();
    clean = ABSOLUTE_PATH_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let prefix = captures.get(1).map_or("", |match_| match_.as_str());
            let token = captures.get(2).map_or("", |match_| match_.as_str());
            format!("{prefix}{}", normalize_path_token(token, lang))
        })
        .into_owned();
    clean = RELATIVE_PATH_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let prefix = captures.get(1).map_or("", |match_| match_.as_str());
            let token = captures.get(2).map_or("", |match_| match_.as_str());
            format!("{prefix}{}", normalize_path_token(token, lang))
        })
        .into_owned();
    clean = FILENAME_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let prefix = captures.get(1).map_or("", |match_| match_.as_str());
            let token = captures.get(2).map_or("", |match_| match_.as_str());
            format!("{prefix}{}", normalize_filename_token(token, lang))
        })
        .into_owned();
    clean = HEX_HASH_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            if is_hex_hash_token(token) {
                normalize_hash_token(token)
            } else {
                token.to_string()
            }
        })
        .into_owned();
    clean = COMMAND_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let tool = captures.get(1).map_or("", |match_| match_.as_str());
            let command = captures.get(2).map_or("", |match_| match_.as_str());
            let spoken_tool = spoken_known_word(tool, lang)
                .map(str::to_string)
                .unwrap_or_else(|| spell_token(&tool.to_ascii_uppercase()));
            format!("{spoken_tool} {command}")
        })
        .into_owned();
    clean = GIT_COMMAND_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let command = captures.get(1).map_or("", |match_| match_.as_str());
            format!("git {command}")
        })
        .into_owned();
    clean = FLAG_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let prefix = captures.get(1).map_or("", |match_| match_.as_str());
            let flag = captures.get(2).map_or("", |match_| match_.as_str());
            let clean_flag = flag.trim_start_matches('-').replace('-', " ");
            format!("{prefix}option {clean_flag}")
        })
        .into_owned();
    clean = normalize_code_symbols(clean, lang, include_single_symbols);
    clean = TECH_WORD_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            spoken_known_word(token, lang).unwrap_or(token).to_string()
        })
        .into_owned();
    clean = ACRONYM_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            spoken_known_word(token, lang)
                .map(str::to_string)
                .unwrap_or_else(|| spell_token(token))
        })
        .into_owned();
    MULTISPACE_RE.replace_all(&clean, " ").trim().to_string()
}

fn looks_like_code_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.len() >= 3 && trimmed.chars().all(|character| "*-_ ".contains(character)) {
        return true;
    }
    if line.starts_with("    ") || line.starts_with('\t') {
        return true;
    }

    let lower = trimmed.to_lowercase();
    let code_prefixes = [
        "::",
        "@@",
        "diff --git",
        "index ",
        "--- ",
        "+++ ",
        "{",
        "}",
        "[",
        "]",
        "<",
        "</",
        "<!--",
        "|",
        "$ ",
        "ps ",
        "use ",
        "let ",
        "const ",
        "fn ",
        "pub ",
        "impl ",
        "struct ",
        "enum ",
        "match ",
        "class ",
        "function ",
        "import ",
        "export ",
        "return ",
        "async fn ",
        "cargo ",
        "git ",
        "npm ",
        "node ",
        "powershell ",
    ];
    if code_prefixes.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }

    if trimmed.ends_with('{')
        || trimmed.ends_with("};")
        || trimmed.ends_with(';')
        || trimmed.contains("=>")
    {
        return true;
    }

    let symbols = trimmed
        .chars()
        .filter(|character| "{}[]();=<>".contains(*character))
        .count();
    symbols >= 4 && symbols * 5 > trimmed.chars().count()
}

fn sanitize_speech_line(line: &str, lang: SpeechLang) -> String {
    let mut clean = MARKDOWN_IMAGE_RE.replace_all(line, " ").into_owned();
    clean = MARKDOWN_LINK_RE.replace_all(&clean, "$1").into_owned();
    clean = DIRECTIVE_RE.replace_all(&clean, " ").into_owned();
    clean = INLINE_CODE_RE
        .replace_all(&clean, |captures: &regex::Captures| {
            let token = captures.get(0).map_or("", |match_| match_.as_str());
            let inner = token.trim_matches('`');
            normalize_speech_fragment(inner, lang, true)
        })
        .into_owned();
    clean = MARKDOWN_HEADING_RE.replace_all(&clean, "").into_owned();
    clean = MARKDOWN_QUOTE_RE.replace_all(&clean, "").into_owned();
    clean = MARKDOWN_BULLET_RE.replace_all(&clean, "").into_owned();
    clean = MARKDOWN_EMPHASIS_RE.replace_all(&clean, "$1").into_owned();
    clean = MARKDOWN_UNDERSCORE_STRONG_RE
        .replace_all(&clean, "$1")
        .into_owned();
    clean = normalize_speech_fragment(&clean, lang, false);
    clean = MARKDOWN_MARKER_RE.replace_all(&clean, "").into_owned();

    let trimmed = clean
        .trim()
        .trim_start_matches("- ")
        .trim_start_matches("* ")
        .trim_start_matches("+ ")
        .trim();
    MULTISPACE_RE.replace_all(trimmed, " ").trim().to_string()
}

fn clean_speech_text_for_language(text: &str, lang: SpeechLang) -> String {
    let mut parts = Vec::new();
    let mut in_code = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code || looks_like_code_line(line) {
            continue;
        }

        let line = sanitize_speech_line(line, lang);
        if !line.is_empty() {
            parts.push(line);
        }
    }

    let clean = MULTISPACE_RE
        .replace_all(&parts.join(" "), " ")
        .trim()
        .to_string();
    clean.chars().take(MAX_SPEECH_CHARS).collect()
}

fn clean_speech_text(text: &str) -> String {
    clean_speech_text_for_language(text, speech_lang_from_code(detect_speech_language(text)))
}

fn estimate_speech_duration(text: &str, speed: f64) -> f64 {
    let words = clean_speech_text(text).split_whitespace().count() as f64;
    let words_per_minute = 165.0 * clamp(speed, 0.7, 1.5, 1.0);
    (words / words_per_minute * 60.0).max(1.0)
}

fn push_speech_chunk(chunks: &mut Vec<String>, text: &str) {
    let source = text.trim();
    if source.is_empty() {
        return;
    }
    if source.chars().count() <= SPEECH_CHUNK_MAX_CHARS {
        chunks.push(source.to_string());
        return;
    }

    let mut current = String::new();
    for word in source.split_whitespace() {
        let next_len =
            current.chars().count() + word.chars().count() + usize::from(!current.is_empty());
        if next_len <= SPEECH_CHUNK_MAX_CHARS {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
            continue;
        }
        if !current.is_empty() {
            chunks.push(current);
            current = String::new();
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
}

fn split_speech_text(text: &str) -> Vec<String> {
    let clean = clean_speech_text(text);
    if clean.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    for sentence in clean
        .split_inclusive(|character| matches!(character, '.' | '!' | '?' | ';' | ':'))
        .map(str::trim)
        .filter(|sentence| !sentence.is_empty())
    {
        let next_len =
            current.chars().count() + sentence.chars().count() + usize::from(!current.is_empty());
        if next_len <= SPEECH_CHUNK_TARGET_CHARS || current.chars().count() < 220 {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(sentence);
            continue;
        }
        push_speech_chunk(&mut chunks, &current);
        current = sentence.to_string();
    }

    if current.is_empty() {
        push_speech_chunk(&mut chunks, &clean);
    } else {
        push_speech_chunk(&mut chunks, &current);
    }
    chunks
}

fn default_windows_voice(voices: &[VoiceInfo], language: &str) -> String {
    let prefix = format!("{}-", language.to_lowercase());
    voices
        .iter()
        .find(|voice| voice.locale.to_lowercase().starts_with(&prefix))
        .or_else(|| {
            voices
                .iter()
                .find(|voice| voice.locale.to_lowercase().starts_with("en-"))
        })
        .or_else(|| voices.first())
        .map(|voice| voice.id.clone())
        .unwrap_or_default()
}

fn detect_speech_language(text: &str) -> &'static str {
    let source = text.to_lowercase();
    let french_markers = [
        "avec",
        "besoin",
        "ca",
        "ce",
        "ces",
        "cest",
        "c'est",
        "chemin",
        "commande",
        "corrige",
        "dans",
        "de",
        "depuis",
        "des",
        "dossier",
        "donc",
        "du",
        "elle",
        "environnement",
        "est",
        "et",
        "faire",
        "faut",
        "fichier",
        "fonction",
        "ici",
        "il",
        "la",
        "le",
        "les",
        "mais",
        "modifie",
        "mon",
        "nous",
        "pour",
        "que",
        "qui",
        "sur",
        "un",
        "une",
        "vous",
    ];
    let english_markers = [
        "about", "also", "and", "are", "because", "can", "does", "for", "from", "have", "how",
        "is", "make", "need", "not", "of", "that", "the", "this", "to", "use", "with", "you",
    ];
    let french = french_markers
        .iter()
        .filter(|marker| source.split_whitespace().any(|word| word == **marker))
        .count();
    let english = english_markers
        .iter()
        .filter(|marker| source.split_whitespace().any(|word| word == **marker))
        .count();
    if french > english + 1 {
        "fr"
    } else {
        "en"
    }
}

fn windows_voice_for_text(
    settings: &Settings,
    voices: &[VoiceInfo],
    text: &str,
) -> (String, String) {
    if settings.windows_voice_mode == "manual" {
        return ("manual".into(), settings.windows_voice.clone());
    }
    let language = detect_speech_language(text).to_string();
    let voice = default_windows_voice(voices, &language);
    (language, voice)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsTtsRequest {
    id: String,
    text_path: String,
    output_path: String,
    rate: i32,
    volume: i32,
    voice: String,
}

struct WindowsTtsWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl WindowsTtsWorker {
    fn start(root: &Path) -> Result<Self, String> {
        let script_path = windows_tts_worker_script_path(root)?;
        let mut command = StdCommand::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script_path.to_string_lossy().as_ref(),
        ]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Windows speech helper did not expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Windows speech helper did not expose stdout".to_string())?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn synthesize(&mut self, request: &WindowsTtsRequest) -> Result<(), String> {
        if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!("Windows speech helper exited with {status}"));
        }

        let payload = serde_json::to_string(request).map_err(|error| error.to_string())?;
        writeln!(self.stdin, "{payload}").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        let mut response_line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut response_line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            return Err("Windows speech helper closed before returning audio".into());
        }

        let response: Value = serde_json::from_str(response_line.trim()).map_err(|error| {
            format!(
                "Windows speech helper returned invalid JSON: {error}; raw={}",
                response_line.trim()
            )
        })?;
        let response_id = response.get("id").and_then(Value::as_str).unwrap_or("");
        if response_id != request.id {
            return Err(format!(
                "Windows speech helper response mismatch: expected {}, got {}",
                request.id, response_id
            ));
        }
        if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(())
        } else {
            Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Windows speech helper failed")
                .to_string())
        }
    }
}

impl Drop for WindowsTtsWorker {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(b"{\"cmd\":\"quit\"}\n");
        let _ = self.stdin.flush();
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn write_script_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if matches!(fs::read_to_string(path), Ok(existing) if existing == content) {
        return Ok(());
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

async fn refresh_windows_voices() -> Vec<VoiceInfo> {
    let script = r#"
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.GetInstalledVoices() | ForEach-Object {
    $info = $_.VoiceInfo
    [PSCustomObject]@{
      id = $info.Name
      label = if ([string]::IsNullOrWhiteSpace($info.Description)) { $info.Name } else { $info.Description }
      locale = $info.Culture.Name
      gender = $info.Gender.ToString()
    }
  } | ConvertTo-Json -Compress
} finally {
  $synth.Dispose()
}
"#;
    let mut command = TokioCommand::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let Ok(output) = command.output().await else {
        return Vec::new();
    };
    let Ok(stdout) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(stdout.trim()) else {
        return Vec::new();
    };
    let list = if parsed.is_array() {
        parsed.as_array().cloned().unwrap_or_default()
    } else {
        vec![parsed]
    };
    list.into_iter()
        .filter_map(|voice| {
            Some(VoiceInfo {
                id: voice.get("id")?.as_str()?.to_string(),
                label: voice
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                locale: voice
                    .get("locale")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                gender: voice
                    .get("gender")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

fn windows_tts_script_path(root: &Path) -> Result<PathBuf, String> {
    let script_path = root.join("windows-sapi-tts.ps1");
    if script_path.exists() {
        return Ok(script_path);
    }
    fs::write(
        &script_path,
        r#"
param(
  [Parameter(Mandatory=$true)][string]$TextPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][int]$Rate,
  [Parameter(Mandatory=$true)][int]$Volume,
  [string]$Voice = ""
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
  if (-not [string]::IsNullOrWhiteSpace($Voice)) {
    $installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
    if ($installed -contains $Voice) {
      $synth.SelectVoice($Voice)
    }
  }
  $synth.SetOutputToWaveFile($OutputPath)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
"#,
    )
    .map_err(|error| error.to_string())?;
    Ok(script_path)
}

fn windows_tts_worker_script_path(root: &Path) -> Result<PathBuf, String> {
    let script_path = root.join("windows-sapi-tts-worker.ps1");
    let content = r#"
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installedVoices = @{}
$synth.GetInstalledVoices() | ForEach-Object {
  $installedVoices[$_.VoiceInfo.Name] = $true
}

function Send-Json([hashtable]$Payload) {
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    $job = $null
    try {
      $job = $line | ConvertFrom-Json
      if ($job.cmd -eq "quit") {
        break
      }

      $textPath = [string]$job.textPath
      $outputPath = [string]$job.outputPath
      $text = [System.IO.File]::ReadAllText($textPath, [System.Text.Encoding]::UTF8)
      $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$job.rate))
      $synth.Volume = [Math]::Max(0, [Math]::Min(100, [int]$job.volume))

      $voice = [string]$job.voice
      if (-not [string]::IsNullOrWhiteSpace($voice) -and $installedVoices.ContainsKey($voice)) {
        $synth.SelectVoice($voice)
      }

      $synth.SetOutputToWaveFile($outputPath)
      try {
        $synth.Speak($text)
      } finally {
        $synth.SetOutputToNull()
      }

      Send-Json @{ ok = $true; id = [string]$job.id; outputPath = $outputPath }
    } catch {
      try { $synth.SetOutputToNull() } catch {}
      $jobId = ""
      if ($null -ne $job -and $null -ne $job.id) {
        $jobId = [string]$job.id
      }
      Send-Json @{ ok = $false; id = $jobId; error = $_.Exception.Message }
    }
  }
} finally {
  $synth.Dispose()
}
"#;
    write_script_if_changed(&script_path, content)?;
    Ok(script_path)
}

fn run_windows_tts_worker(root: &Path, request: &WindowsTtsRequest) -> Result<(), String> {
    let mut guard = WINDOWS_TTS_WORKER
        .lock()
        .map_err(|_| "Windows speech helper lock was poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(WindowsTtsWorker::start(root)?);
    }

    let first_result = guard
        .as_mut()
        .expect("Windows speech helper should be initialized")
        .synthesize(request);
    if first_result.is_ok() {
        return first_result;
    }

    let first_error = first_result.expect_err("error checked above");
    *guard = None;
    *guard = Some(WindowsTtsWorker::start(root).map_err(|restart_error| {
        format!("Windows speech helper failed: {first_error}; restart failed: {restart_error}")
    })?);
    guard
        .as_mut()
        .expect("Windows speech helper should be initialized after restart")
        .synthesize(request)
        .map_err(|retry_error| {
            format!("Windows speech helper failed: {first_error}; retry failed: {retry_error}")
        })
}

fn run_windows_tts_once_blocking(
    root: &Path,
    text_path: &Path,
    wav_path: &Path,
    sapi_rate: i32,
    volume: i32,
    voice: &str,
) -> Result<(), String> {
    let script_path = windows_tts_script_path(root)?;
    let mut command = StdCommand::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path)
        .arg("-TextPath")
        .arg(text_path)
        .arg("-OutputPath")
        .arg(wav_path)
        .arg("-Rate")
        .arg(sapi_rate.to_string())
        .arg("-Volume")
        .arg(volume.to_string())
        .arg("-Voice")
        .arg(voice)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Windows speech synthesis failed: {}",
            detail.trim()
        ))
    }
}

fn synthesize_windows_text_blocking(
    clean: String,
    settings: Settings,
    voices: Vec<VoiceInfo>,
) -> Result<Value, String> {
    let clips = env::temp_dir().join("qdex-tauri");
    fs::create_dir_all(&clips).map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let text_path = clips.join(format!("{id}.txt"));
    let wav_path = clips.join(format!("{id}.wav"));
    let speed = clamp(settings.speed, 0.7, 1.5, 1.0);
    let sapi_rate = ((speed - 1.0) * 20.0).round() as i32;
    let volume = (clamp(settings.volume, 0.0, 1.0, 0.85) * 100.0).round() as i32;
    let (language, voice) = windows_voice_for_text(&settings, &voices, &clean);

    fs::write(&text_path, clean.as_bytes()).map_err(|error| error.to_string())?;
    let request = WindowsTtsRequest {
        id: id.clone(),
        text_path: text_path.to_string_lossy().to_string(),
        output_path: wav_path.to_string_lossy().to_string(),
        rate: sapi_rate,
        volume,
        voice: voice.clone(),
    };

    let synthesis_result = run_windows_tts_worker(&clips, &request).or_else(|helper_error| {
        let _ = fs::remove_file(&wav_path);
        run_windows_tts_once_blocking(&clips, &text_path, &wav_path, sapi_rate, volume, &voice)
            .map_err(|fallback_error| {
                format!(
                    "Windows fast speech helper failed: {helper_error}; fallback failed: {fallback_error}"
                )
            })
    });
    if let Err(error) = synthesis_result {
        let _ = fs::remove_file(&text_path);
        let _ = fs::remove_file(&wav_path);
        return Err(error);
    }

    let bytes = fs::read(&wav_path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&text_path);
    let _ = fs::remove_file(&wav_path);
    Ok(json!({
        "audioUrl": format!("data:audio/wav;base64,{}", general_purpose::STANDARD.encode(bytes)),
        "durationSeconds": estimate_speech_duration(&clean, speed),
        "language": language,
        "speechSpeed": speed,
        "synthesisMode": "windows-persistent",
        "voiceId": voice,
        "volume": settings.volume
    }))
}

async fn synthesize_windows_text(
    text: &str,
    settings: &Settings,
    voices: &[VoiceInfo],
) -> Result<Value, String> {
    let clean = text.trim().to_string();
    if clean.is_empty() {
        return Ok(Value::Null);
    }
    let settings = settings.clone();
    let voices = voices.to_vec();
    tokio::task::spawn_blocking(move || synthesize_windows_text_blocking(clean, settings, voices))
        .await
        .map_err(|error| format!("Windows speech synthesis task failed: {error}"))?
}

fn signed_percent(value: i32) -> String {
    if value >= 0 {
        format!("+{value}%")
    } else {
        format!("{value}%")
    }
}

fn signed_hertz(value: i32) -> String {
    if value >= 0 {
        format!("+{value}Hz")
    } else {
        format!("{value}Hz")
    }
}

async fn synthesize_edge_text(text: &str, settings: &Settings) -> Result<Value, String> {
    let clean = text.trim().to_string();
    if clean.is_empty() {
        return Ok(Value::Null);
    }

    let speed = clamp(settings.speed, 0.7, 1.5, 1.0);
    let rate = ((speed - 1.0) * 100.0).round() as i32;
    let pitch = settings.edge_pitch.clamp(-50, 50);
    let client = EdgeTtsClient::builder()
        .ws_pool_size(0)
        .ws_warmup(false)
        .request_chunk_reuse(true)
        .build()
        .map_err(|error| error.to_string())?;
    let result = client
        .synthesize(
            clean.clone(),
            SpeakOptions {
                voice: settings.edge_voice.clone(),
                rate: signed_percent(rate),
                volume: "+0%".into(),
                pitch: signed_hertz(pitch),
                boundary: Boundary::Sentence,
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    Ok(json!({
        "audioUrl": format!("data:audio/mpeg;base64,{}", general_purpose::STANDARD.encode(result.audio)),
        "durationSeconds": estimate_speech_duration(&clean, speed),
        "speechSpeed": speed,
        "voiceId": settings.edge_voice,
        "volume": settings.volume
    }))
}

fn queue_output(app: &AppHandle, shared: &SharedState, text: String, force: bool) {
    queue_output_with_metadata(app, shared, text, force, "codex-log".into(), Value::Null);
}

fn queue_output_with_metadata(
    app: &AppHandle,
    shared: &SharedState,
    text: String,
    force: bool,
    source: String,
    metadata: Value,
) {
    if clean_speech_text(&text).is_empty() {
        return;
    }

    let should_spawn = {
        let mut state = shared.lock().expect("reader state poisoned");
        if !state.settings.enabled && !force {
            return;
        }
        if state.speech_queue.len() >= MAX_QUEUE {
            state.speech_queue.pop_front();
            state.skipped += 1;
            status(
                app,
                "warning",
                &format!(
                    "Output arrived faster than speech; skipped {} older item(s).",
                    state.skipped
                ),
            );
        }
        state.speech_queue.push_back(SpeechItem {
            text,
            force,
            source,
            metadata,
        });
        if state.speech_busy {
            false
        } else {
            state.speech_busy = true;
            true
        }
    };

    if should_spawn {
        let app = app.clone();
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            process_queue(app, shared).await;
        });
    }
}

async fn wait_for_speech(
    shared: &SharedState,
    playback_id: &str,
    milliseconds: u64,
    token: u64,
) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(milliseconds.min(60_000));
    while std::time::Instant::now() < deadline {
        {
            let state = shared.lock().expect("reader state poisoned");
            if state.cancel_version != token {
                return false;
            }
            if state.finished_playback_id.as_deref() == Some(playback_id) {
                return true;
            }
        }
        sleep(Duration::from_millis(180)).await;
    }
    shared.lock().expect("reader state poisoned").cancel_version == token
}

async fn process_queue(app: AppHandle, shared: SharedState) {
    loop {
        let Some(item) = ({
            let mut state = shared.lock().expect("reader state poisoned");
            match state.speech_queue.pop_front() {
                Some(item) => Some(item),
                None => {
                    state.speech_busy = false;
                    None
                }
            }
        }) else {
            status(&app, "ready", "Reader idle.");
            return;
        };

        let (settings, voices, token) = {
            let state = shared.lock().expect("reader state poisoned");
            (
                state.settings.clone(),
                state.windows_voices.clone(),
                state.cancel_version,
            )
        };

        if !settings.enabled && !item.force {
            continue;
        }

        let is_edge = settings.engine == "edge";
        let chunks = split_speech_text(&item.text);
        if chunks.is_empty() {
            continue;
        }

        status(
            &app,
            "working",
            if is_edge {
                "Rendering visible output with Edge Neural TTS."
            } else {
                "Rendering visible output with Windows local TTS."
            },
        );

        for (index, chunk) in chunks.iter().enumerate() {
            let cancelled = shared.lock().expect("reader state poisoned").cancel_version != token;
            if cancelled {
                break;
            }

            let synthesized = if is_edge {
                synthesize_edge_text(chunk, &settings).await
            } else {
                synthesize_windows_text(chunk, &settings, &voices).await
            };
            match synthesized {
                Ok(mut clip) if !clip.is_null() => {
                    let cancelled =
                        shared.lock().expect("reader state poisoned").cancel_version != token;
                    if cancelled {
                        break;
                    }
                    let playback_id = Uuid::new_v4().to_string();
                    if let Some(object) = clip.as_object_mut() {
                        object.insert("playbackId".into(), json!(playback_id));
                        object.insert("chunkIndex".into(), json!(index + 1));
                        object.insert("chunkCount".into(), json!(chunks.len()));
                    }
                    let playback_id = clip
                        .get("playbackId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    {
                        let mut state = shared.lock().expect("reader state poisoned");
                        state.current_playback_id = Some(playback_id.clone());
                        state.finished_playback_id = None;
                    }
                    emit_payload(&app, "reader:audio", clip.clone());
                    append_bridge_broadcast(&json!({
                        "type": "audio",
                        "source": item.source,
                        "createdAt": now(),
                        "text": item.text,
                        "metadata": item.metadata,
                        "clip": clip
                    }));
                    status(
                        &app,
                        "speaking",
                        if chunks.len() > 1 {
                            if is_edge {
                                "Reading visible Codex output in chunks with Edge Neural TTS."
                            } else {
                                "Reading visible Codex output in chunks with Windows local TTS."
                            }
                        } else if is_edge {
                            "Reading visible Codex output with Edge Neural TTS."
                        } else {
                            match clip.get("language").and_then(Value::as_str).unwrap_or("") {
                                "fr" => "Reading visible Codex output with Windows French TTS.",
                                "en" => "Reading visible Codex output with Windows English TTS.",
                                _ => "Reading visible Codex output with Windows local TTS.",
                            }
                        },
                    );
                    let duration_ms = clip
                        .get("durationSeconds")
                        .and_then(Value::as_f64)
                        .map(|seconds| (seconds * 1000.0).max(600.0) as u64)
                        .unwrap_or(1000);
                    let _ = wait_for_speech(&shared, &playback_id, duration_ms, token).await;
                    let mut state = shared.lock().expect("reader state poisoned");
                    if state.current_playback_id.as_deref() == Some(&playback_id) {
                        state.current_playback_id = None;
                    }
                    if state.finished_playback_id.as_deref() == Some(&playback_id) {
                        state.finished_playback_id = None;
                    }
                }
                Ok(_) => {
                    append_bridge_broadcast(&json!({
                        "type": "audio_skipped",
                        "source": item.source,
                        "createdAt": now(),
                        "text": chunk,
                        "metadata": item.metadata
                    }));
                }
                Err(error) => {
                    append_bridge_broadcast(&json!({
                        "type": "audio_error",
                        "source": item.source,
                        "createdAt": now(),
                        "text": chunk,
                        "metadata": item.metadata,
                        "error": error
                    }));
                    shared
                        .lock()
                        .expect("reader state poisoned")
                        .speech_queue
                        .clear();
                    status(
                        &app,
                        "error",
                        &format!(
                            "{} speech failed: {error}",
                            if is_edge { "Edge" } else { "Windows" }
                        ),
                    );
                    break;
                }
            }
        }
    }
}

fn cancel_current_speech(app: &AppHandle, shared: &SharedState, message: &str) {
    {
        let mut state = shared.lock().expect("reader state poisoned");
        state.cancel_version += 1;
        state.speech_queue.clear();
        state.current_playback_id = None;
        state.finished_playback_id = None;
    }
    emit_payload(app, "reader:stop-audio", json!({}));
    status(app, "ready", message);
}

#[tauri::command]
fn get_state(state: tauri::State<'_, SharedState>) -> PublicState {
    shared_public_state(state.inner())
}

#[tauri::command]
async fn attach_active(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<PublicSession>, String> {
    attach_active_internal(&app, state.inner(), None, "manual", false).await
}

#[tauri::command]
async fn set_settings(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    settings: Value,
) -> Result<PublicState, String> {
    let next = apply_speech_settings(state.inner(), &settings);
    if !next.enabled {
        cancel_current_speech(&app, state.inner(), "Reading is off.");
        status(&app, "off", "Reading is off.");
    } else {
        status(&app, "ready", "Reading is on.");
    }
    Ok(shared_public_state(state.inner()))
}

#[tauri::command]
async fn test_voice(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    settings: Value,
) -> Result<PublicState, String> {
    apply_speech_settings(state.inner(), &settings);
    queue_output(
        &app,
        state.inner(),
        "QDex is listening for new visible Codex output.".into(),
        true,
    );
    Ok(shared_public_state(state.inner()))
}

#[tauri::command]
async fn read_text(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    payload: Value,
) -> Result<PublicState, String> {
    if let Some(settings) = payload.get("settings") {
        apply_speech_settings(state.inner(), settings);
    }
    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
    queue_output(&app, state.inner(), text.into(), true);
    Ok(shared_public_state(state.inner()))
}

#[tauri::command]
fn finish_speech(state: tauri::State<'_, SharedState>, playback_id: String) -> PublicState {
    {
        let mut reader = state.inner().lock().expect("reader state poisoned");
        if reader.current_playback_id.as_deref() == Some(playback_id.as_str()) {
            reader.finished_playback_id = Some(playback_id);
        }
    }
    shared_public_state(state.inner())
}

#[tauri::command]
fn skip_speech(app: AppHandle, state: tauri::State<'_, SharedState>) -> PublicState {
    cancel_current_speech(&app, state.inner(), "Skipped current read.");
    shared_public_state(state.inner())
}

#[tauri::command]
fn minimize(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    hide_to_tray(app, window)
}

#[tauri::command]
fn hide_to_tray(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    status(
        &app,
        "ready",
        "QDex is hidden in the system tray and still listening.",
    );
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_settings_panel_open(window: WebviewWindow, open: bool) -> Result<Value, String> {
    let size = if open {
        LogicalSize::new(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    } else {
        LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT)
    };
    window.set_size(size).map_err(|error| error.to_string())?;
    Ok(json!({ "open": open }))
}

fn start_background_tasks(app: AppHandle, shared: SharedState) {
    tauri::async_runtime::spawn(async move {
        let voices = refresh_windows_voices().await;
        {
            let mut state = shared.lock().expect("reader state poisoned");
            state.windows_voices = voices;
            state.settings = normalize_settings(&json!({}), &state.settings, &state.windows_voices);
        }
        let _ = attach_active_internal(&app, &shared, None, "startup", false).await;

        let mut elapsed = 0_u64;
        loop {
            read_added_lines(&app, &shared).await;
            if elapsed >= ACTIVE_SESSION_SCAN_MS {
                auto_attach_active(&app, &shared).await;
                elapsed = 0;
            }
            sleep(Duration::from_millis(SESSION_POLL_MS)).await;
            elapsed += SESSION_POLL_MS;
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show QDex", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit QDex", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("qdex")
        .tooltip("QDex")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "show" {
                show_main_window(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

pub fn run() {
    let shared: SharedState = Arc::new(Mutex::new(ReaderState::new()));
    tauri::Builder::default()
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![
            get_state,
            attach_active,
            set_settings,
            test_voice,
            read_text,
            finish_speech,
            skip_speech,
            minimize,
            hide_to_tray,
            close,
            set_settings_panel_open
        ])
        .setup(move |app| {
            setup_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }
            start_background_tasks(app.handle().clone(), shared.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running QDex Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_cleaner_normalizes_paths_code_and_directives() {
        let text = r#"Done in `renderer/renderer.js`.
C:\Users\name\Documents\TTS\codex-output-reader\src-tauri\src\main.rs:12
```rust
const value = "do not read this";
```
::git-push{cwd="C:\repo" branch="main"}
Here is the user-facing summary."#;

        let clean = clean_speech_text(text);

        assert!(clean.contains("Done in"));
        assert!(clean.contains("Here is the user-facing summary."));
        assert!(clean.contains("renderer dot JavaScript"));
        assert!(!clean.contains("C drive"));
        assert!(clean.contains("main dot Rust line 12"));
        assert!(!clean.contains("const value"));
        assert!(!clean.contains("git-push"));
    }

    #[test]
    fn speech_normalizer_reads_technical_tokens_in_french() {
        let text = "Le fichier `src/components/App.tsx` lit JSON depuis `.env` et /api/users/:id.";

        let clean = clean_speech_text_for_language(text, SpeechLang::Fr);

        assert!(clean.contains("App point T S X"));
        assert!(clean.contains("jison"));
        assert!(clean.contains("fichier d'environnement"));
        assert!(clean.contains("parametre id"));
    }

    #[test]
    fn speech_normalizer_auto_detects_short_french_text() {
        let text = "Le fichier `.env` configure JSON.";

        let clean = clean_speech_text(text);

        assert!(clean.contains("fichier d'environnement"));
        assert!(clean.contains("jison"));
    }

    #[test]
    fn speech_normalizer_reads_technical_tokens_in_english() {
        let text = "The file `config.json` reads API keys from `.env.local` on localhost:3000.";

        let clean = clean_speech_text_for_language(text, SpeechLang::En);

        assert!(clean.contains("config dot jason"));
        assert!(clean.contains("A P I keys"));
        assert!(clean.contains("local environment file"));
        assert!(clean.contains("localhost port 3000"));
    }

    #[test]
    fn speech_normalizer_reads_known_markdown_files_naturally() {
        let clean =
            clean_speech_text_for_language("Update `README.md` and `AGENTS.md:3`.", SpeechLang::En);

        assert!(clean.contains("read me dot Markdown"));
        assert!(clean.contains("agent dot Markdown line 3"));
        assert!(!clean.contains("R E A D M E"));
        assert!(!clean.contains("A G E N T S"));
    }

    #[test]
    fn speech_cleaner_keeps_normal_sentences() {
        let text = "QDex reads new Codex responses aloud and stays quiet in the tray.";
        assert_eq!(clean_speech_text(text), text);
    }

    #[test]
    fn speech_cleaner_removes_markdown_markers() {
        let text = r#"# Update

**Fixed** the reader loop.

* Added cleaner speech text.
* Removed *noisy* Markdown markers.

> This should read as normal text.

---"#;

        let clean = clean_speech_text(text);

        assert!(clean.contains("Update"));
        assert!(clean.contains("Fixed the reader loop."));
        assert!(clean.contains("Added cleaner speech text."));
        assert!(clean.contains("Removed noisy Markdown markers."));
        assert!(clean.contains("This should read as normal text."));
        assert!(!clean.contains('*'));
        assert!(!clean.contains('#'));
        assert!(!clean.contains('>'));
    }

    #[test]
    fn speech_splitter_chunks_long_messages() {
        let text = r#"Oui, c’est possible. Et même assez propre.

La condition importante: Q-Link ne peut pas attraper directement une image affichée dans Codex Desktop. Il faut une convention locale: Codex doit enregistrer l’image dans un dossier connu, puis Q-Link surveille ce dossier et l’envoie à Telegram.

La meilleure architecture serait:

Tu envoies une demande image depuis Telegram, idéalement avec une commande comme image ou génère une image.
Q-Link crée un identifiant de requête et ajoute au prompt une consigne automatique du genre: Si tu génères une image, enregistre-la dans le dossier image outbox de Q-Link avec ce nom précis.
Codex génère ou prépare l’image et la sauvegarde dans ce dossier.
Q-Link surveille le dossier.
Dès qu’un nouveau fichier image est stable, par exemple PNG, JPEG ou WebP, Q-Link l’envoie au même chat Telegram avec sendPhoto.
Q-Link marque le fichier comme envoyé pour éviter les doublons.

Donc oui: faisable. Mais il faut ajouter un petit système côté Q-Link plus une instruction automatique envoyée à Codex pour qu’il range bien l’image au bon endroit."#;

        let chunks = split_speech_text(text);

        assert!(chunks.len() >= 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= SPEECH_CHUNK_MAX_CHARS));
        assert!(chunks[0].starts_with("Oui"));
    }
}

fn main() {
    run();
}
