#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use edge_tts_rust::{Boundary, EdgeTtsClient, SpeakOptions};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    env, fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, LogicalSize, Manager, WebviewWindow,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{process::Command, time::sleep};
use uuid::Uuid;

const ACTIVE_SESSION_SCAN_MS: u64 = 2000;
const SESSION_POLL_MS: u64 = 250;
const MAX_QUEUE: usize = 4;
const MAX_SPEECH_CHARS: usize = 7000;
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
}

struct ReaderState {
    settings: Settings,
    windows_voices: Vec<VoiceInfo>,
    current_session: Option<SessionState>,
    current_usage: Option<Value>,
    current_activity: Activity,
    speech_queue: VecDeque<SpeechItem>,
    speech_busy: bool,
    cancel_version: u64,
    skipped: usize,
    attach_in_flight: bool,
}

type SharedState = Arc<Mutex<ReaderState>>;

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
        let clean = line.trim();
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

fn clean_speech_text(text: &str) -> String {
    let mut clean = String::new();
    let mut in_code = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            if !clean.ends_with(" Code block omitted. ") {
                clean.push_str(" Code block omitted. ");
            }
            continue;
        }
        if !in_code {
            clean.push_str(line);
            clean.push(' ');
        }
    }
    clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SPEECH_CHARS)
        .collect()
}

fn estimate_speech_duration(text: &str, speed: f64) -> f64 {
    let words = clean_speech_text(text).split_whitespace().count() as f64;
    let words_per_minute = 165.0 * clamp(speed, 0.7, 1.5, 1.0);
    (words / words_per_minute * 60.0).max(1.0)
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
        "avec", "besoin", "cest", "c'est", "dans", "des", "donc", "elle", "est", "faire", "faut",
        "ici", "mais", "mon", "nous", "pour", "que", "qui", "sur", "une", "vous",
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
    let mut command = Command::new("powershell.exe");
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

async fn synthesize_windows_text(
    text: &str,
    settings: &Settings,
    voices: &[VoiceInfo],
) -> Result<Value, String> {
    let clean = clean_speech_text(text);
    if clean.is_empty() {
        return Ok(Value::Null);
    }
    let clips = env::temp_dir().join("qdex-tauri");
    fs::create_dir_all(&clips).map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let text_path = clips.join(format!("{id}.txt"));
    let wav_path = clips.join(format!("{id}.wav"));
    let script_path = windows_tts_script_path(&clips)?;
    let speed = clamp(settings.speed, 0.7, 1.5, 1.0);
    let sapi_rate = ((speed - 1.0) * 20.0).round() as i32;
    let volume = (clamp(settings.volume, 0.0, 1.0, 0.85) * 100.0).round() as i32;
    let (language, voice) = windows_voice_for_text(settings, voices, &clean);

    fs::write(&text_path, clean.as_bytes()).map_err(|error| error.to_string())?;
    let mut command = Command::new("powershell.exe");
    let rate_arg = sapi_rate.to_string();
    let volume_arg = volume.to_string();
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script_path.to_string_lossy().as_ref(),
        "-TextPath",
        text_path.to_string_lossy().as_ref(),
        "-OutputPath",
        wav_path.to_string_lossy().as_ref(),
        "-Rate",
        &rate_arg,
        "-Volume",
        &volume_arg,
        "-Voice",
        &voice,
    ]);
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let output = command.output().await.map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_file(&text_path);
        let _ = fs::remove_file(&wav_path);
        return Err(format!(
            "Windows speech synthesis failed: {}",
            detail.trim()
        ));
    }

    let bytes = fs::read(&wav_path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&text_path);
    let _ = fs::remove_file(&wav_path);
    Ok(json!({
        "audioUrl": format!("data:audio/wav;base64,{}", general_purpose::STANDARD.encode(bytes)),
        "durationSeconds": estimate_speech_duration(&clean, speed),
        "language": language,
        "speechSpeed": speed,
        "voiceId": voice,
        "volume": settings.volume
    }))
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
    let clean = clean_speech_text(text);
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
        state.speech_queue.push_back(SpeechItem { text, force });
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

async fn wait_for_speech(shared: &SharedState, milliseconds: u64, token: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(milliseconds.min(90_000));
    while std::time::Instant::now() < deadline {
        let cancelled = shared.lock().expect("reader state poisoned").cancel_version != token;
        if cancelled {
            return false;
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
        status(
            &app,
            "working",
            if is_edge {
                "Rendering visible output with Edge Neural TTS."
            } else {
                "Rendering visible output with Windows local TTS."
            },
        );
        let synthesized = if is_edge {
            synthesize_edge_text(&item.text, &settings).await
        } else {
            synthesize_windows_text(&item.text, &settings, &voices).await
        };
        match synthesized {
            Ok(clip) if !clip.is_null() => {
                let cancelled =
                    shared.lock().expect("reader state poisoned").cancel_version != token;
                if cancelled {
                    continue;
                }
                emit_payload(&app, "reader:audio", clip.clone());
                status(
                    &app,
                    "speaking",
                    if is_edge {
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
                let _ = wait_for_speech(&shared, duration_ms, token).await;
            }
            Ok(_) => {}
            Err(error) => {
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
            }
        }
    }
}

fn cancel_current_speech(app: &AppHandle, shared: &SharedState, message: &str) {
    {
        let mut state = shared.lock().expect("reader state poisoned");
        state.cancel_version += 1;
        state.speech_queue.clear();
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
    status(&app, "ready", "QDex is hidden in the system tray and still listening.");
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

fn main() {
    run();
}
