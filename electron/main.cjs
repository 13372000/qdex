const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "..");
loadLocalEnv();
const execFileAsync = promisify(execFile);

const APP_ID = "local.qdex";
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
const EDGE_VOICES = [
  { id: "en-US-AvaMultilingualNeural", label: "Ava Multilingual", locale: "en-US", gender: "Female" },
  { id: "en-US-JennyNeural", label: "Jenny", locale: "en-US", gender: "Female" },
  { id: "en-US-AriaNeural", label: "Aria", locale: "en-US", gender: "Female" },
  { id: "en-US-EmmaNeural", label: "Emma", locale: "en-US", gender: "Female" },
  { id: "en-GB-SoniaNeural", label: "Sonia", locale: "en-GB", gender: "Female" },
  { id: "fr-FR-VivienneMultilingualNeural", label: "Vivienne Multilingual", locale: "fr-FR", gender: "Female" },
  { id: "fr-FR-DeniseNeural", label: "Denise", locale: "fr-FR", gender: "Female" },
  { id: "fr-CA-SylvieNeural", label: "Sylvie", locale: "fr-CA", gender: "Female" },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew Multilingual", locale: "en-US", gender: "Male" },
  { id: "fr-FR-RemyMultilingualNeural", label: "Remy Multilingual", locale: "fr-FR", gender: "Male" }
];
const TTS_ENGINES = new Set(["edge", "supertonic", "windows"]);
const WINDOWS_VOICE_MODES = new Set(["auto", "manual"]);
const MODEL_FILES = [
  "duration_predictor.onnx",
  "text_encoder.onnx",
  "vector_estimator.onnx",
  "vocoder.onnx",
  "tts.json",
  "unicode_indexer.json"
];
const MAX_QUEUE = 4;
const MAX_SPEECH_CHARS = 7000;
const EDGE_CHUNK_TARGET_CHARS = 360;
const EDGE_CHUNK_MAX_CHARS = 700;
const ACTIVE_SESSION_SCAN_MS = numberFromEnv("QDEX_ACTIVE_SESSION_SCAN_MS", 2000, 500, 15000);
const WINDOW_WIDTH = numberFromEnv("QDEX_WINDOW_WIDTH", 430, 340, 900);
const WINDOW_HEIGHT = numberFromEnv("QDEX_WINDOW_HEIGHT", 132, 108, 280);
const SETTINGS_WINDOW_WIDTH = numberFromEnv("QDEX_SETTINGS_WINDOW_WIDTH", 520, 430, 900);
const SETTINGS_WINDOW_HEIGHT = numberFromEnv("QDEX_SETTINGS_WINDOW_HEIGHT", 320, 220, 600);
const DEFAULT_ENGINE = TTS_ENGINES.has(process.env.QDEX_TTS_ENGINE)
  ? process.env.QDEX_TTS_ENGINE
  : "edge";
const DEFAULT_EDGE_VOICE = EDGE_VOICES.some((voice) => voice.id === process.env.QDEX_EDGE_VOICE)
  ? process.env.QDEX_EDGE_VOICE
  : "en-US-AvaMultilingualNeural";
const DEFAULT_SETTINGS = {
  enabled: true,
  engine: DEFAULT_ENGINE,
  edgeVoice: DEFAULT_EDGE_VOICE,
  edgePitch: 0,
  windowsVoiceMode: WINDOWS_VOICE_MODES.has(process.env.QDEX_WINDOWS_VOICE_MODE)
    ? process.env.QDEX_WINDOWS_VOICE_MODE
    : "auto",
  windowsVoice: process.env.QDEX_WINDOWS_VOICE || "",
  voice: "F1",
  speed: 1.05,
  totalStep: 4,
  volume: 0.85
};

let mainWindow;
let tray = null;
let currentSession = null;
let currentUsage = null;
let currentActivity = {
  detail: "Starting up",
  state: "starting",
  timestamp: now(),
  title: "Launching QDex"
};
let activeSessionScanner = null;
let attachInFlight = false;
let helperModule;
let edgeTtsModule;
let model;
let modelAssetRoot = "";
let windowsVoices = [];
const voiceStyles = new Map();
const toolCalls = new Map();
const speech = {
  queue: [],
  busy: false,
  settings: { ...DEFAULT_SETTINGS },
  cancelVersion: 0,
  skipped: 0
};

function now() {
  return new Date().toISOString();
}

function loadLocalEnv() {
  const envPath = path.join(projectRoot, ".env");
  try {
    process.loadEnvFile?.(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function numberFromEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, value));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function status(state, message) {
  send("reader:status", { state, message, timestamp: now() });
}

function setActivity(state, title, detail = "", metadata = {}) {
  currentActivity = {
    detail,
    metadata,
    state,
    timestamp: now(),
    title
  };
  send("reader:activity", currentActivity);
}

function concise(value, maximum = 88) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}...` : clean;
}

function parseArguments(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function activityForToolCall(payload) {
  const args = parseArguments(payload.arguments);
  const namespace = String(payload.namespace || "");
  const toolName = String(payload.name || "");
  const toolId = namespace ? `${namespace}.${toolName}` : toolName;
  let activity = {
    detail: concise(toolId || "tool call"),
    metadata: { callId: payload.call_id, toolId },
    state: "working",
    title: "Using tool"
  };

  if (toolName === "shell_command") {
    activity = {
      ...activity,
      detail: concise(args.command || "PowerShell command"),
      title: "Running command"
    };
  } else if (toolName === "apply_patch") {
    activity = {
      ...activity,
      detail: "Applying file changes",
      title: "Editing files"
    };
  } else if (toolName === "update_plan") {
    activity = {
      ...activity,
      detail: "Refreshing the task checklist",
      title: "Updating plan"
    };
  } else if (toolName === "view_image") {
    activity = {
      ...activity,
      detail: concise(args.path || "local image"),
      title: "Viewing image"
    };
  } else if (toolName === "imagegen") {
    activity = {
      ...activity,
      detail: "Generating image asset",
      title: "Creating image"
    };
  } else if (toolId.includes("web.") || toolName.includes("fetch") || toolName.includes("openapi")) {
    activity = {
      ...activity,
      detail: concise(args.url || args.search_query?.[0]?.q || toolId),
      title: "Fetching web/docs"
    };
  } else if (namespace.includes("openaiDeveloperDocs")) {
    activity = {
      ...activity,
      detail: concise(args.url || args.query || toolId),
      title: "Reading docs"
    };
  }

  if (payload.call_id) {
    toolCalls.set(payload.call_id, activity);
  }
  return activity;
}

function activityFromRow(row) {
  const payload = row.payload || {};

  if (row.type === "response_item") {
    if (payload.type === "reasoning") {
      return { state: "thinking", title: "Thinking", detail: "Planning the next visible step" };
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      return activityForToolCall(payload);
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const prior = payload.call_id ? toolCalls.get(payload.call_id) : null;
      if (payload.call_id) {
        toolCalls.delete(payload.call_id);
      }
      return {
        detail: prior?.title ? `${prior.title} finished` : "Tool returned output",
        metadata: { callId: payload.call_id },
        state: "working",
        title: "Reading tool output"
      };
    }
    if (payload.type === "message") {
      return {
        detail: payload.phase === "final_answer" ? "Preparing final visible response" : "Writing visible response",
        state: "replying",
        title: "Drafting reply"
      };
    }
  }

  if (row.type !== "event_msg") {
    return null;
  }

  if (payload.type === "token_count") {
    return null;
  }
  if (payload.type === "agent_message") {
    return {
      detail: payload.phase === "final_answer" ? "Final answer became visible" : "Sending a visible update",
      state: "replying",
      title: payload.phase === "final_answer" ? "Final response" : "Updating you"
    };
  }
  if (payload.type === "mcp_tool_call_begin") {
    return {
      detail: concise(`${payload.invocation?.server || "MCP"} ${payload.invocation?.tool || "tool"}`),
      metadata: { callId: payload.call_id },
      state: "working",
      title: "Calling MCP tool"
    };
  }
  if (payload.type === "mcp_tool_call_end") {
    return {
      detail: concise(`${payload.invocation?.tool || "MCP tool"} finished`),
      metadata: { callId: payload.call_id },
      state: "working",
      title: "Reading MCP output"
    };
  }
  if (payload.type === "exec_command_begin") {
    return {
      detail: concise(payload.command || payload.cmd || "command started"),
      state: "working",
      title: "Running command"
    };
  }
  if (payload.type === "exec_command_end") {
    return {
      detail: `Exit ${payload.exit_code ?? "?"}`,
      state: payload.exit_code ? "warning" : "working",
      title: "Command finished"
    };
  }
  if (payload.type === "patch_apply_begin") {
    return { state: "working", title: "Editing files", detail: "Applying patch" };
  }
  if (payload.type === "patch_apply_end") {
    return { state: "working", title: "Patch applied", detail: "File changes saved" };
  }
  if (payload.type === "user_message") {
    return { state: "input", title: "User prompt received", detail: "New request in active session" };
  }
  if (payload.type === "error") {
    return { state: "error", title: "Codex error", detail: concise(payload.message || payload.error) };
  }

  return {
    detail: concise(payload.type || "observable event"),
    state: "working",
    title: "Codex activity"
  };
}

function packagedIconImage() {
  const iconPath = appIconPath();
  return iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
}

function appIconPath() {
  const iconPath = path.join(app.getAppPath(), "build", "icon.ico");
  return fs.existsSync(iconPath) ? iconPath : "";
}

function createTrayIcon() {
  const packaged = packagedIconImage();
  if (!packaged.isEmpty()) {
    return packaged;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#1b1d20"/>
    <path d="M9 9h14v14H9z" fill="#2d3035" stroke="#c7d0d8" stroke-width="1.5"/>
    <path d="M12 16h8M16 12v8" stroke="#eef1f2" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function restoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.focus();
}

function ensureTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("QDex - listening for Codex output");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show QDex", click: restoreWindow },
    {
      label: "Test voice",
      click: () => queueOutput({ text: "QDex is still listening while hidden." }, true)
    },
    { type: "separator" },
    { label: "Quit QDex", click: () => app.quit() }
  ]));
  tray.on("click", restoreWindow);
  tray.on("double-click", restoreWindow);
  return tray;
}

function hideToTray() {
  ensureTray();
  status("ready", "QDex is hidden to tray and still listening.");
  mainWindow?.hide();
}

function resizeWindowForSettings(open) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const current = mainWindow.getBounds();
  const width = open ? SETTINGS_WINDOW_WIDTH : WINDOW_WIDTH;
  const height = open ? SETTINGS_WINDOW_HEIGHT : WINDOW_HEIGHT;
  mainWindow.setBounds({
    x: Math.round(current.x + current.width - width),
    y: current.y,
    width,
    height
  }, true);
  mainWindow.setAlwaysOnTop(true, "screen-saver");
}

function bundledAssetRoot() {
  return path.join(__dirname, "..", "assets");
}

function downloadedAssetRoot() {
  return path.join(app.getPath("userData"), "assets");
}

function requiredAssetPaths(root) {
  return [
    ...MODEL_FILES.map((fileName) => path.join(root, "onnx", fileName)),
    ...VOICES.map((voice) => path.join(root, "voice_styles", `${voice}.json`))
  ];
}

function assetsReady(root) {
  return requiredAssetPaths(root).every((filePath) => fs.existsSync(filePath));
}

function activeAssetRoot() {
  return assetsReady(bundledAssetRoot()) ? bundledAssetRoot() : downloadedAssetRoot();
}

async function refreshWindowsVoices() {
  if (process.platform !== "win32") {
    windowsVoices = [];
    return windowsVoices;
  }

  const script = `
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
`.trim();

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    windowsVoices = list
      .filter((voice) => voice && voice.id)
      .map((voice) => ({
        id: String(voice.id),
        label: String(voice.label || voice.id),
        locale: String(voice.locale || ""),
        gender: String(voice.gender || "")
      }));
  } catch (_error) {
    windowsVoices = [];
  }
  return windowsVoices;
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function windowsVoiceForLanguage(language) {
  const prefix = `${String(language || "").toLowerCase()}-`;
  if (!prefix || prefix === "-") {
    return "";
  }
  return windowsVoices.find((voice) => voice.locale.toLowerCase().startsWith(prefix))?.id || "";
}

function defaultWindowsVoice(language = "en") {
  const envVoice = String(DEFAULT_SETTINGS.windowsVoice || "");
  if (windowsVoices.some((voice) => voice.id === envVoice)) {
    return envVoice;
  }
  return windowsVoiceForLanguage(language)
    || windowsVoiceForLanguage("en")
    || windowsVoices[0]?.id
    || "";
}

function detectSpeechLanguage(text) {
  const source = String(text || "").toLowerCase();
  if (!source.trim()) {
    return "en";
  }

  let french = /[àâçéèêëîïôùûüÿœ]/.test(source) ? 4 : 0;
  let english = 0;
  const words = source.match(/[a-zàâçéèêëîïôùûüÿœ']+/g) || [];
  const frenchMarkers = new Set([
    "alors", "avec", "aussi", "aux", "besoin", "c'est", "ca", "ça", "car", "ce", "cela", "cette",
    "comme", "dans", "des", "donc", "du", "elle", "est", "etre", "être", "fait", "faire", "faut",
    "ici", "il", "je", "la", "le", "les", "mais", "mes", "mon", "nous", "on", "ou", "où", "pas",
    "peux", "plus", "pour", "quand", "que", "qui", "se", "si", "sur", "ton", "tu", "une", "vous"
  ]);
  const englishMarkers = new Set([
    "about", "after", "also", "and", "are", "because", "but", "can", "could", "does", "for", "from",
    "have", "how", "into", "is", "it", "make", "need", "not", "now", "of", "on", "or", "should",
    "so", "that", "the", "this", "to", "use", "was", "we", "what", "when", "where", "with", "would",
    "you", "your"
  ]);

  for (const word of words) {
    if (frenchMarkers.has(word)) {
      french += 1;
    }
    if (englishMarkers.has(word)) {
      english += 1;
    }
  }

  return french > english + 1 ? "fr" : "en";
}

function windowsVoiceForText(text) {
  if (speech.settings.windowsVoiceMode === "auto") {
    const language = detectSpeechLanguage(text);
    return {
      language,
      voice: windowsVoiceForLanguage(language) || speech.settings.windowsVoice || defaultWindowsVoice(language)
    };
  }

  return {
    language: "manual",
    voice: speech.settings.windowsVoice || defaultWindowsVoice()
  };
}

function normalizedSettings(settings = {}) {
  const edgeVoice = EDGE_VOICES.some((voice) => voice.id === settings.edgeVoice)
    ? settings.edgeVoice
    : DEFAULT_SETTINGS.edgeVoice;
  const windowsVoiceMode = WINDOWS_VOICE_MODES.has(settings.windowsVoiceMode)
    ? settings.windowsVoiceMode
    : DEFAULT_SETTINGS.windowsVoiceMode;
  const requestedWindowsVoice = String(settings.windowsVoice || DEFAULT_SETTINGS.windowsVoice || "");
  const windowsVoice = windowsVoices.some((voice) => voice.id === requestedWindowsVoice)
    ? requestedWindowsVoice
    : defaultWindowsVoice("en");
  return {
    enabled: Boolean(settings.enabled),
    engine: TTS_ENGINES.has(settings.engine) ? settings.engine : DEFAULT_SETTINGS.engine,
    edgeVoice,
    edgePitch: Math.round(clamp(settings.edgePitch, -50, 50, DEFAULT_SETTINGS.edgePitch)),
    windowsVoiceMode,
    windowsVoice,
    voice: VOICES.includes(settings.voice) ? settings.voice : DEFAULT_SETTINGS.voice,
    speed: clamp(settings.speed, 0.7, 1.5, DEFAULT_SETTINGS.speed),
    totalStep: Math.round(clamp(settings.totalStep, 2, 12, DEFAULT_SETTINGS.totalStep)),
    volume: clamp(settings.volume, 0, 1, DEFAULT_SETTINGS.volume)
  };
}

function publicSession(session) {
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    sourcePath: session.sourcePath,
    attachedAt: session.attachedAt
  };
}

function publicState() {
  const root = activeAssetRoot();
  return {
    assetsReady: assetsReady(root),
    assetRoot: root,
    modelLoaded: Boolean(model && modelAssetRoot === root),
    edgeVoices: EDGE_VOICES,
    windowsVoices,
    voices: VOICES,
    settings: speech.settings,
    usage: currentUsage,
    activity: currentActivity,
    session: publicSession(currentSession)
  };
}

function codexSessionsRoot() {
  if (process.env.QDEX_CODEX_SESSIONS_ROOT) {
    return path.resolve(process.env.QDEX_CODEX_SESSIONS_ROOT);
  }
  return path.join(app.getPath("home"), ".codex", "sessions");
}

async function collectJsonlFiles(directory, files = []) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (_error) {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const file = await fs.promises.stat(entryPath);
      files.push({ path: entryPath, mtimeMs: file.mtimeMs });
    }
  }
  return files;
}

async function newestRolloutPath() {
  const files = await collectJsonlFiles(codexSessionsRoot());
  const latest = files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error("No Codex rollout logs were found under ~/.codex/sessions.");
  }
  return latest.path;
}

async function firstJsonLine(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(text.split(/\r?\n/, 1)[0]);
}

async function threadName(threadId) {
  const indexPath = path.join(app.getPath("home"), ".codex", "session_index.jsonl");
  try {
    const lines = (await fs.promises.readFile(indexPath, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const row = JSON.parse(line);
      if (row.id === threadId && row.thread_name) {
        return row.thread_name;
      }
    }
  } catch (_error) {
    // A fresh session may not have an index name yet.
  }
  return `active-${threadId.slice(0, 8)}`;
}

function closeSession(session) {
  if (session) {
    session.closed = true;
  }
  clearInterval(session?.poller);
  session?.watcher?.close();
}

function startActiveSessionScanner() {
  if (activeSessionScanner) {
    return;
  }
  activeSessionScanner = setInterval(() => {
    void autoAttachActive();
  }, ACTIVE_SESSION_SCAN_MS);
}

function stopActiveSessionScanner() {
  clearInterval(activeSessionScanner);
  activeSessionScanner = null;
}

function epochMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return number > 1000000000000 ? number : number * 1000;
}

function usageFromRow(row) {
  if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
    return null;
  }

  const limits = row.payload.rate_limits;
  const primary = limits?.primary;
  const usedPercent = Number(primary?.used_percent);
  const windowMinutes = Number(primary?.window_minutes);
  const resetMs = epochMilliseconds(primary?.resets_at);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || !resetMs) {
    return null;
  }

  const secondaryUsedPercent = Number(limits?.secondary?.used_percent);
  const contextWindow = Number(row.payload.info?.model_context_window);
  const lastUsage = row.payload.info?.last_token_usage || {};
  const contextTokens = Number(lastUsage.total_tokens);
  const contextUsedPercent = Number.isFinite(contextTokens) && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.max(0, Math.min(100, contextTokens / contextWindow * 100))
    : null;
  return {
    timestamp: row.timestamp || now(),
    limitId: limits?.limit_id || "codex",
    planType: limits?.plan_type || "",
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    contextTokens: Number.isFinite(contextTokens) ? contextTokens : null,
    contextUsedPercent,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
    windowMinutes,
    resetsAt: primary.resets_at,
    resetAtIso: new Date(resetMs).toISOString(),
    secondaryUsedPercent: Number.isFinite(secondaryUsedPercent) ? secondaryUsedPercent : null,
    rateLimitReachedType: limits?.rate_limit_reached_type || null
  };
}

function usageExpired(usage, graceMs = 60000) {
  const resetMs = usage?.resetAtIso
    ? new Date(usage.resetAtIso).getTime()
    : epochMilliseconds(usage?.resetsAt);
  return Number.isFinite(resetMs) && Date.now() >= resetMs + graceMs;
}

function sendUsage(usage) {
  currentUsage = usage && !usageExpired(usage, 0) ? usage : null;
  send("reader:usage", currentUsage);
}

async function latestUsageFromFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes('"token_count"')) {
      continue;
    }
    try {
      const usage = usageFromRow(JSON.parse(line));
      if (usage && !usageExpired(usage)) {
        return usage;
      }
    } catch (_error) {
      // Ignore malformed or partial rollout rows while the file is active.
    }
  }
  return null;
}

function visibleCodexOutput(row) {
  if (row.type !== "event_msg" || row.payload?.type !== "agent_message") {
    return null;
  }

  const text = String(row.payload.message || "").trim();
  if (!text) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    timestamp: row.timestamp || now(),
    text,
    phase: row.payload.phase || ""
  };
}

function readAddedLines(session) {
  if (!session || session.closed || currentSession !== session) {
    return;
  }
  if (session.reading) {
    session.readAgain = true;
    return;
  }

  session.reading = true;
  fs.promises.stat(session.sourcePath)
    .then(async (stat) => {
      if (session.closed || currentSession !== session) {
        return;
      }
      if (stat.size < session.offset) {
        session.offset = 0;
        session.carry = "";
      }
      if (stat.size === session.offset) {
        return;
      }

      const length = stat.size - session.offset;
      const handle = await fs.promises.open(session.sourcePath, "r");
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, session.offset);
      await handle.close();
      if (session.closed || currentSession !== session) {
        return;
      }
      session.offset = stat.size;

      const lines = `${session.carry}${buffer.toString("utf8")}`.split(/\r?\n/);
      session.carry = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const row = JSON.parse(line);
          const nextActivity = activityFromRow(row);
          if (nextActivity) {
            setActivity(nextActivity.state, nextActivity.title, nextActivity.detail, nextActivity.metadata);
          }

          const usage = usageFromRow(row);
          if (usage) {
            sendUsage(usage);
          }

          const output = visibleCodexOutput(row);
          if (output) {
            send("reader:output", output);
            queueOutput(output);
          }
        } catch (_error) {
          // Rollout files can contain partial lines while they are still being appended.
        }
      }
    })
    .catch((error) => status("error", `Could not read the Codex output log: ${error.message}`))
    .finally(() => {
      session.reading = false;
      if (!session.closed && currentSession === session && session.readAgain) {
        session.readAgain = false;
        readAddedLines(session);
      }
    });
}

async function attachActive(options = {}) {
  const sourcePath = options.sourcePath || await newestRolloutPath();
  if (currentSession?.sourcePath === sourcePath) {
    if (!options.quiet) {
      sendUsage(await latestUsageFromFile(sourcePath).catch(() => currentUsage));
      status("ready", `Still listening to ${currentSession.name}.`);
    }
    return publicSession(currentSession);
  }

  closeSession(currentSession);
  sendUsage(null);
  const meta = await firstJsonLine(sourcePath);
  const stat = await fs.promises.stat(sourcePath);
  const id = meta.payload?.id || crypto.randomUUID();
  currentSession = {
    id,
    name: await threadName(id),
    cwd: meta.payload?.cwd || "",
    sourcePath,
    attachedAt: now(),
    offset: stat.size,
    carry: "",
    reading: false,
    readAgain: false
  };
  currentSession.poller = setInterval(() => readAddedLines(currentSession), 250);
  currentSession.watcher = fs.watch(sourcePath, () => readAddedLines(currentSession));
  send("reader:session", publicSession(currentSession));
  sendUsage(await latestUsageFromFile(sourcePath).catch(() => null));
  setActivity(
    "session",
    options.reason === "auto" ? "Switched session" : "Monitoring session",
    currentSession.name
  );
  status(
    "ready",
    options.reason === "auto"
      ? `Auto-attached to ${currentSession.name}.`
      : `Listening for new visible Codex output from ${currentSession.name}.`
  );
  return publicSession(currentSession);
}

async function autoAttachActive() {
  if (attachInFlight) {
    return;
  }

  attachInFlight = true;
  try {
    const sourcePath = await newestRolloutPath();
    if (currentSession?.sourcePath !== sourcePath) {
      await attachActive({ sourcePath, reason: "auto" });
    }
  } catch (error) {
    if (!currentSession) {
      status("warning", error.message);
    }
  } finally {
    attachInFlight = false;
  }
}

function cleanSpeechText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[#>*\-\d.\s]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function helper() {
  if (!helperModule) {
    helperModule = await import(pathToFileURL(path.join(__dirname, "..", "supertonic", "helper.js")).href);
  }
  return helperModule;
}

async function edgeTts() {
  if (!edgeTtsModule) {
    edgeTtsModule = await import("@andresaya/edge-tts");
  }
  return edgeTtsModule;
}

async function ensureModel() {
  const root = activeAssetRoot();
  if (!assetsReady(root)) {
    throw new Error("Supertonic assets are missing. Download them in this app first.");
  }
  if (model && modelAssetRoot !== root) {
    await releaseSupertonicModel();
  }
  if (model && modelAssetRoot === root) {
    return model;
  }

  status("loading", "Loading the local Supertonic model on CPU.");
  const api = await helper();
  model = await api.loadTextToSpeech(path.join(root, "onnx"));
  modelAssetRoot = root;
  voiceStyles.clear();
  status("ready", "Local Supertonic model is loaded.");
  return model;
}

async function releaseSupertonicModel() {
  const loadedModel = model;
  model = null;
  modelAssetRoot = "";
  voiceStyles.clear();
  if (!loadedModel?.release) {
    return;
  }

  try {
    await loadedModel.release();
  } catch (error) {
    console.warn("Could not release Supertonic model:", error);
  }
}

async function applySpeechSettings(settings) {
  const previousEngine = speech.settings.engine;
  const nextSettings = normalizedSettings(settings);
  speech.settings = nextSettings;
  if (previousEngine === "supertonic" && nextSettings.engine !== "supertonic") {
    await releaseSupertonicModel();
  }
  return nextSettings;
}

async function voiceStyle(voice) {
  const key = `${activeAssetRoot()}:${voice}`;
  if (!voiceStyles.has(key)) {
    const api = await helper();
    voiceStyles.set(key, api.loadVoiceStyle([
      path.join(activeAssetRoot(), "voice_styles", `${voice}.json`)
    ]));
  }
  return voiceStyles.get(key);
}

async function synthesizeSupertonicText(clean) {
  const ttsModel = await ensureModel();
  const api = await helper();
  const result = await ttsModel.call(
    clean.slice(0, MAX_SPEECH_CHARS),
    "en",
    await voiceStyle(speech.settings.voice),
    speech.settings.totalStep,
    speech.settings.speed
  );
  const clips = path.join(app.getPath("temp"), "codex-output-reader");
  await fs.promises.mkdir(clips, { recursive: true });
  const wavPath = path.join(clips, `${crypto.randomUUID()}.wav`);
  api.writeWavFile(wavPath, result.wav, ttsModel.sampleRate);
  const bytes = await fs.promises.readFile(wavPath);
  await fs.promises.rm(wavPath, { force: true });
  return {
    audioUrl: `data:audio/wav;base64,${bytes.toString("base64")}`,
    durationSeconds: result.duration[0] || 0,
    speechSpeed: speech.settings.speed,
    volume: speech.settings.volume
  };
}

async function synthesizeEdgeText(clean) {
  const { Constants, EdgeTTS } = await edgeTts();
  const tts = new EdgeTTS();
  const rate = `${Math.round((speech.settings.speed - 1) * 100)}%`;
  const pitch = `${speech.settings.edgePitch >= 0 ? "+" : ""}${speech.settings.edgePitch}Hz`;
  await tts.synthesize(clean.slice(0, MAX_SPEECH_CHARS), speech.settings.edgeVoice, {
    outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
    pitch,
    rate,
    volume: "100%"
  });

  const bytes = tts.toBuffer();
  return {
    audioUrl: `data:audio/mpeg;base64,${bytes.toString("base64")}`,
    durationSeconds: Math.max(Number(tts.getDuration?.()) || 0, estimateSpeechDuration(clean, speech.settings.speed)),
    speechSpeed: speech.settings.speed,
    volume: speech.settings.volume
  };
}

async function windowsTtsScriptPath(root) {
  const scriptPath = path.join(root, "windows-sapi-tts.ps1");
  await fs.promises.writeFile(scriptPath, `
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
`.trim(), "utf8");
  return scriptPath;
}

async function synthesizeWindowsText(clean) {
  const clips = path.join(app.getPath("temp"), "codex-output-reader");
  await fs.promises.mkdir(clips, { recursive: true });
  const id = crypto.randomUUID();
  const textPath = path.join(clips, `${id}.txt`);
  const wavPath = path.join(clips, `${id}.wav`);
  const speed = clamp(speech.settings.speed, 0.7, 1.5, 1);
  const sapiRate = Math.round((speed - 1) * 20);
  const volume = Math.round(clamp(speech.settings.volume, 0, 1, 0.85) * 100);
  const selected = windowsVoiceForText(clean);

  try {
    await fs.promises.writeFile(textPath, clean.slice(0, MAX_SPEECH_CHARS), "utf8");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      await windowsTtsScriptPath(clips),
      "-TextPath",
      textPath,
      "-OutputPath",
      wavPath,
      "-Rate",
      String(sapiRate),
      "-Volume",
      String(volume),
      "-Voice",
      String(selected.voice || "")
    ], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    const bytes = await fs.promises.readFile(wavPath);
    return {
      audioUrl: `data:audio/wav;base64,${bytes.toString("base64")}`,
      durationSeconds: estimateSpeechDuration(clean, speed),
      language: selected.language,
      speechSpeed: speed,
      voiceId: selected.voice,
      volume: speech.settings.volume
    };
  } finally {
    await fs.promises.rm(textPath, { force: true }).catch(() => {});
    await fs.promises.rm(wavPath, { force: true }).catch(() => {});
  }
}

async function synthesizeText(text) {
  const clean = cleanSpeechText(text);
  if (!clean) {
    return null;
  }

  if (speech.settings.engine === "edge") {
    return synthesizeEdgeText(clean);
  }
  if (speech.settings.engine === "windows") {
    return synthesizeWindowsText(clean);
  }
  return synthesizeSupertonicText(clean);
}

function splitSpeechText(text) {
  const source = cleanSpeechText(text).slice(0, MAX_SPEECH_CHARS);
  if (!source) {
    return [];
  }

  const chunks = [];
  const sentences = source.match(/[^.!?;:]+[.!?;:]?(?:\s+|$)/g) || [source];
  let current = "";

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) {
      continue;
    }

    const next = current ? `${current} ${piece}` : piece;
    if (next.length <= EDGE_CHUNK_TARGET_CHARS || current.length < 120) {
      current = next;
      continue;
    }

    pushSpeechChunk(chunks, current);
    current = piece;
  }

  pushSpeechChunk(chunks, current);
  return chunks;
}

function pushSpeechChunk(chunks, text) {
  const source = cleanSpeechText(text);
  if (!source) {
    return;
  }
  if (source.length <= EDGE_CHUNK_MAX_CHARS) {
    chunks.push(source);
    return;
  }

  const words = source.split(/\s+/);
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= EDGE_CHUNK_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = word;
  }
  if (current) {
    chunks.push(current);
  }
}

function estimateSpeechDuration(text, speed) {
  const words = cleanSpeechText(text).split(/\s+/).filter(Boolean).length;
  const wordsPerMinute = 165 * clamp(speed, 0.7, 1.5, 1);
  return Math.max(1, words / wordsPerMinute * 60);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cancelCurrentSpeech(message = "Skipped current read.") {
  speech.cancelVersion += 1;
  send("reader:stop-audio", {});
  status("ready", message);
}

function speechCancelled(token) {
  return token !== speech.cancelVersion;
}

async function waitForSpeech(milliseconds, token) {
  const deadline = Date.now() + Math.min(90000, Math.max(0, milliseconds));
  while (Date.now() < deadline) {
    if (speechCancelled(token)) {
      return false;
    }
    await wait(Math.min(180, deadline - Date.now()));
  }
  return !speechCancelled(token);
}

async function speakEdgeText(clean, token) {
  const chunks = splitSpeechText(clean);
  if (!chunks.length) {
    return;
  }

  let totalDurationSeconds = 0;
  let playbackStartedAt = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (speechCancelled(token)) {
      return;
    }
    const clip = await synthesizeEdgeText(chunks[index]);
    if (!clip || speechCancelled(token)) {
      continue;
    }

    if (!playbackStartedAt) {
      playbackStartedAt = Date.now();
      status("speaking", chunks.length > 1 ? `Reading chunk 1/${chunks.length} with Edge Neural TTS.` : "Reading visible Codex output with Edge Neural TTS.");
    }

    totalDurationSeconds += clip.durationSeconds;
    send("reader:audio", { ...clip, chunkIndex: index + 1, chunkCount: chunks.length });
  }

  const elapsedMs = playbackStartedAt ? Date.now() - playbackStartedAt : 0;
  const remainingMs = totalDurationSeconds * 1000 - elapsedMs;
  await waitForSpeech(Math.max(600, remainingMs), token);
}

async function speakSupertonicText(clean, token) {
  const clip = await synthesizeSupertonicText(clean);
  if (!clip || speechCancelled(token)) {
    return;
  }

  send("reader:audio", clip);
  status("speaking", "Reading visible Codex output. No API call was used.");
  await waitForSpeech(Math.max(600, clip.durationSeconds * 1000), token);
}

async function speakWindowsText(clean, token) {
  const clip = await synthesizeWindowsText(clean);
  if (!clip || speechCancelled(token)) {
    return;
  }

  send("reader:audio", clip);
  status("speaking", clip.language === "fr"
    ? "Reading visible Codex output with Windows French TTS."
    : clip.language === "en"
      ? "Reading visible Codex output with Windows English TTS."
      : "Reading visible Codex output with Windows local TTS.");
  await waitForSpeech(Math.max(600, clip.durationSeconds * 1000), token);
}

function queueOutput(output, force = false) {
  if ((!speech.settings.enabled && !force) || !cleanSpeechText(output.text)) {
    return;
  }
  if (speech.queue.length >= MAX_QUEUE) {
    speech.queue.shift();
    speech.skipped += 1;
    status("warning", `Output arrived faster than speech; skipped ${speech.skipped} older item${speech.skipped === 1 ? "" : "s"}.`);
  }
  speech.queue.push({ text: output.text, force });
  processQueue();
}

async function processQueue() {
  if (speech.busy) {
    return;
  }
  speech.busy = true;

  while (speech.queue.length) {
    const item = speech.queue.shift();
    if (!speech.settings.enabled && !item.force) {
      continue;
    }

    try {
      const clean = cleanSpeechText(item.text);
      if (!clean) {
        continue;
      }

      const token = speech.cancelVersion;
      status(
        "working",
        speech.settings.engine === "edge"
          ? "Rendering the first speech chunk with Edge Neural TTS."
          : speech.settings.engine === "windows"
            ? "Rendering visible output with Windows local TTS."
            : "Rendering new visible Codex output locally."
      );
      if (speech.settings.engine === "edge") {
        await speakEdgeText(clean, token);
      } else if (speech.settings.engine === "windows") {
        await speakWindowsText(clean, token);
      } else {
        await speakSupertonicText(clean, token);
      }
    } catch (error) {
      speech.queue = [];
      const label = speech.settings.engine === "edge" ? "Edge" : speech.settings.engine === "windows" ? "Windows" : "Local";
      status("error", `${label} speech failed: ${error.message}`);
    }
  }

  speech.busy = false;
  if (speech.settings.enabled) {
    status("ready", "Reader idle.");
  }
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${path.basename(destination)} download failed: ${response.status} ${response.statusText}`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function downloadAssets() {
  const root = downloadedAssetRoot();
  const files = [
    ...MODEL_FILES.map((fileName) => ({ remote: `onnx/${fileName}`, local: path.join(root, "onnx", fileName) })),
    ...VOICES.map((voice) => ({ remote: `voice_styles/${voice}.json`, local: path.join(root, "voice_styles", `${voice}.json`) }))
  ];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (fs.existsSync(file.local)) {
      continue;
    }
    status("downloading", `Downloading ${file.remote} (${index + 1}/${files.length}).`);
    await downloadFile(`https://huggingface.co/Supertone/supertonic-3/resolve/main/${file.remote}?download=true`, file.local);
  }
  status("ready", "Supertonic assets are ready locally.");
  return publicState();
}

function registerIpc() {
  ipcMain.handle("reader:get-state", () => publicState());
  ipcMain.handle("reader:attach-active", () => attachActive({ reason: "manual" }));
  ipcMain.handle("reader:download-assets", () => downloadAssets());
  ipcMain.handle("reader:set-settings", async (_event, settings) => {
    await applySpeechSettings(settings);
    if (!speech.settings.enabled) {
      speech.queue = [];
      cancelCurrentSpeech("Reading is off.");
      status("off", "Reading is off.");
    } else {
      status("ready", "Reading is on.");
    }
    return publicState();
  });
  ipcMain.handle("reader:test-voice", async (_event, settings) => {
    await applySpeechSettings(settings);
    queueOutput({ text: "QDex is listening for new visible Codex output." }, true);
    return publicState();
  });
  ipcMain.handle("reader:read-text", async (_event, payload = {}) => {
    await applySpeechSettings(payload.settings || speech.settings);
    queueOutput({ text: String(payload.text || "") }, true);
    return publicState();
  });
  ipcMain.handle("reader:skip-speech", () => {
    cancelCurrentSpeech("Skipped current read.");
    return publicState();
  });
  ipcMain.handle("reader:minimize", () => {
    hideToTray();
  });
  ipcMain.handle("reader:set-settings-panel-open", (_event, open) => {
    resizeWindowForSettings(Boolean(open));
    return { open: Boolean(open) };
  });
  ipcMain.handle("reader:hide-to-tray", () => {
    hideToTray();
  });
  ipcMain.handle("reader:close", () => {
    mainWindow?.close();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    icon: appIconPath() || undefined,
    resizable: false,
    transparent: true,
    title: "QDex",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on("restore", () => mainWindow?.setAlwaysOnTop(true, "screen-saver"));
  mainWindow.on("show", () => mainWindow?.setAlwaysOnTop(true, "screen-saver"));
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.argv.includes("--devtools")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  await refreshWindowsVoices();
  speech.settings = normalizedSettings(speech.settings);
  registerIpc();
  createWindow();
  try {
    await attachActive({ reason: "startup" });
  } catch (error) {
    status("warning", error.message);
  }
  startActiveSessionScanner();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopActiveSessionScanner();
  closeSession(currentSession);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void releaseSupertonicModel();
});
