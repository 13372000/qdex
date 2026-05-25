const bridge = window.codexReader;
const nodes = {
  contextCluster: document.querySelector("#context-cluster"),
  contextGauge: document.querySelector("#context-gauge"),
  edgePitch: document.querySelector("#edge-pitch"),
  edgePitchValue: document.querySelector("#edge-pitch-value"),
  edgeVoice: document.querySelector("#edge-voice"),
  enabled: document.querySelector("#enabled"),
  engine: document.querySelector("#engine"),
  faster: document.querySelector("#faster"),
  minimize: document.querySelector("#minimize"),
  outputs: document.querySelector("#outputs"),
  playPause: document.querySelector("#play-pause"),
  projectName: document.querySelector("#project-name"),
  readAgain: document.querySelector("#read-again"),
  resetTime: document.querySelector("#reset-time"),
  sessionFolder: document.querySelector("#session-folder"),
  sessionLight: document.querySelector("#session-light"),
  sessionLog: document.querySelector("#session-log"),
  sessionTitle: document.querySelector("#session-title"),
  settingsClose: document.querySelector("#settings-close"),
  settingsOpen: document.querySelector("#settings-open"),
  settingsPanel: document.querySelector("#settings-panel"),
  skipRead: document.querySelector("#skip-read"),
  slower: document.querySelector("#slower"),
  speed: document.querySelector("#speed"),
  speedValue: document.querySelector("#speed-value"),
  status: document.querySelector("#status"),
  test: document.querySelector("#test"),
  usageCluster: document.querySelector("#usage-cluster"),
  usageGauge: document.querySelector("#usage-gauge"),
  usagePercent: document.querySelector("#usage-percent"),
  waveSeek: document.querySelector("#wave-seek"),
  waveform: document.querySelector("#waveform"),
  volume: document.querySelector("#volume"),
  volumeValue: document.querySelector("#volume-value"),
  windowsMode: document.querySelector("#windows-mode"),
  windowsVoice: document.querySelector("#windows-voice")
};

let state;
let audio = null;
let audioPlaying = false;
let activeClip = null;
let activityState = null;
let lastOutputText = "";
let pendingSeekRatio = null;
let statusState = "info";
let usageState = null;
const audioQueue = [];
const MAX_AUDIO_QUEUE = 8;
const WAVEFORM_SAMPLE_RATE = 1000;
const VISUALIZER_DB_FLOOR = -48;
const VISUALIZER_DB_CEIL = -6;
const WAVEFORM_IDLE_FRAME_MS = 220;
const WAVEFORM_HIDDEN_FRAME_MS = 1000;
const SPEED_STEP = 0.05;
const IDLE_MESSAGES = [
  "Waiting for work.",
  "Bench is clear.",
  "Ready to cook.",
  "No task on the stove.",
  "Standing by.",
  "Bring the next idea.",
  "Tools are warm.",
  "Nothing queued yet.",
  "Quiet bench, sharp tools.",
  "Waiting for the next move.",
  "No output to read.",
  "Ready when you are.",
  "Work queue empty.",
  "Idle, but not asleep.",
  "The pan is cold.",
  "Send something spicy.",
  "Nothing burning yet.",
  "Holding position.",
  "Waiting on fresh logs.",
  "Cook mode armed.",
  "No visible work yet.",
  "Give me a thread to pull.",
  "Still watching.",
  "Standing at the board.",
  "Ready for the next build.",
  "No text to chew.",
  "The station is clean.",
  "Awaiting signal.",
  "Quiet for now.",
  "Work can start anytime.",
  "The cursor is hungry.",
  "No sparks yet.",
  "Still on watch.",
  "Waiting for visible output.",
  "Idle with intent.",
  "Fresh task, fresh fire."
];
const wave = {
  context: nodes.waveform.getContext("2d"),
  audioContext: null,
  decoded: null,
  frame: [],
  level: 0,
  loading: false,
  nextFrame: null,
  nextTimer: null,
  player: null
};

function text(value) {
  return String(value || "");
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function option(value, label = value) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function clampNumber(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function amplitudeToLevel(rms, peak = rms) {
  const amplitude = clampNumber((rms * 0.88) + (peak * 0.12), 0.000001, 1);
  const db = 20 * Math.log10(amplitude);
  return clampNumber((db - VISUALIZER_DB_FLOOR) / (VISUALIZER_DB_CEIL - VISUALIZER_DB_FLOOR), 0, 1);
}

function sampleEnergy(data, start, end, stride = 1) {
  const first = Math.max(0, Math.floor(start));
  const last = Math.min(data.length, Math.max(first + 1, Math.ceil(end)));
  const step = Math.max(1, Math.floor(stride));
  let sum = 0;
  let peak = 0;
  let count = 0;

  for (let index = first; index < last; index += step) {
    const sample = data[index] || 0;
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    count += 1;
  }

  return amplitudeToLevel(Math.sqrt(sum / Math.max(1, count)), peak);
}

function columnNoise(index, salt = 0) {
  const hash = Math.sin((index + 1) * (12.9898 + salt * 19.19)) * 43758.5453;
  return hash - Math.floor(hash);
}

function readSavedSettings() {
  try {
    return JSON.parse(localStorage.getItem("codex-output-reader.settings") || "{}");
  } catch (_error) {
    return {};
  }
}

function currentSettings() {
  return {
    enabled: nodes.enabled.checked,
    engine: nodes.engine.value || "edge",
    edgeVoice: nodes.edgeVoice.value || "en-US-AvaMultilingualNeural",
    edgePitch: nodes.edgePitch.value,
    windowsVoiceMode: nodes.windowsMode.value || "auto",
    windowsVoice: nodes.windowsVoice.value || "",
    speed: nodes.speed.value,
    volume: nodes.volume.value
  };
}

function saveSettings() {
  localStorage.setItem("codex-output-reader.settings", JSON.stringify(currentSettings()));
}

function setSettingsOpen(open) {
  if (open) {
    nodes.settingsPanel.hidden = false;
  } else {
    nodes.settingsPanel.dataset.closing = "true";
    window.setTimeout(() => {
      if (document.body.dataset.settingsOpen === "true") {
        return;
      }
      nodes.settingsPanel.hidden = true;
      delete nodes.settingsPanel.dataset.closing;
    }, 160);
  }
  nodes.settingsOpen.dataset.active = String(open);
  document.body.dataset.settingsOpen = String(open);
  void bridge?.setSettingsPanelOpen?.(open);
}

function syncEnabledControls(checked) {
  nodes.enabled.checked = checked;
}

function syncEngineControls() {
  const engine = nodes.engine.value || "edge";
  document.body.dataset.ttsEngine = engine;
  document.body.dataset.windowsVoiceMode = nodes.windowsMode.value || "auto";

  const supportedEngines = state?.supportedEngines || ["edge", "windows"];
  const canTest = supportedEngines.includes(engine);
  nodes.test.disabled = !canTest;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return number % 1 === 0 ? String(number) : number.toFixed(1);
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours <= 0 ? `${minutes}m` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  if (number >= 1000000) {
    return `${(number / 1000000).toFixed(1)}m`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1)}k`;
  }
  return String(Math.round(number));
}

function idleMessage() {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return IDLE_MESSAGES[minuteBucket % IDLE_MESSAGES.length];
}

function showIdleMessage() {
  const message = idleMessage();
  setSessionActive(false);
  nodes.status.className = "state-ready";
  nodes.status.textContent = message;
  nodes.status.title = message;
}

function setSessionActive(active) {
  document.body.dataset.sessionActive = String(Boolean(active));
  nodes.sessionLight.title = active ? "Codex session is active" : "Codex session is idle";
}

function activityLooksActive(value) {
  return ["input", "loading", "downloading", "speaking", "thinking", "working", "replying"].includes(String(value || ""));
}

function setUsageGauge(value) {
  const number = Number(value);
  const hasUsage = Number.isFinite(number);
  const remaining = hasUsage ? clampNumber(number, 0, 100) : 0;
  nodes.usageGauge.style.setProperty("--gauge", `${remaining * 3.6}deg`);
  nodes.usageGauge.dataset.level = remaining <= 12 ? "low" : remaining <= 32 ? "warning" : "ok";
  nodes.usagePercent.textContent = hasUsage ? `${formatPercent(remaining)}%` : "--";
}

function setContextGauge(usage) {
  const percent = Number(usage?.contextUsedPercent);
  const hasContext = Number.isFinite(percent);
  const used = hasContext ? clampNumber(percent, 0, 100) : 0;
  nodes.contextGauge.style.setProperty("--context-gauge", `${used * 3.6}deg`);
  nodes.contextGauge.dataset.level = used >= 90 ? "high" : used >= 70 ? "warning" : "ok";

  if (!hasContext) {
    nodes.contextCluster.title = "No context-window token sample yet.";
    return;
  }

  nodes.contextCluster.title = `Context window ${formatPercent(used)}% full (${formatTokenCount(usage.contextTokens)} / ${formatTokenCount(usage.contextWindow)} tokens).`;
}

function resetDateFromUsage(usage) {
  const date = new Date(usage?.resetAtIso || Number(usage?.resetsAt) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resetUsageDisplay(message = "Waiting for fresh Codex token_count after usage reset.") {
  usageState = null;
  setUsageGauge(null);
  setContextGauge(null);
  nodes.resetTime.textContent = "--:--";
  nodes.usageCluster.title = message;
}

function showUsage(usage) {
  usageState = usage || null;
  if (!usageState) {
    resetUsageDisplay("No Codex token_count event has arrived yet.");
    return;
  }

  const resetAt = resetDateFromUsage(usageState);
  if (resetAt && Date.now() >= resetAt.getTime()) {
    resetUsageDisplay("Usage window reset. Waiting for the next Codex token_count sample.");
    return;
  }

  const resetTime = !resetAt
    ? "--:--"
    : resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const used = formatPercent(usageState.usedPercent);
  const untilReset = !resetAt ? "unknown" : formatDuration(resetAt.getTime() - Date.now());
  setUsageGauge(usageState.remainingPercent);
  setContextGauge(usageState);
  nodes.resetTime.textContent = resetTime;
  nodes.usageCluster.title = `${used}% used. Reset ${resetAt ? resetAt.toLocaleString() : "unknown"} (${untilReset}).`;
}

function showActivity(activity) {
  activityState = activity || null;
  if (activityState?.title) {
    const message = activityState.detail
      ? `${activityState.title} - ${activityState.detail}`
      : activityState.title;
    setSessionActive(activityLooksActive(activityState.state));
    nodes.status.className = `state-${activityState.state || "info"}`;
    nodes.status.textContent = message;
    nodes.status.title = message;
    return;
  }
  showIdleMessage();
}

function waveIntensity() {
  if (!audioPlaying || !audio || wave.player !== audio || !wave.decoded) {
    wave.level *= 0.66;
    return wave.level;
  }

  const { data, sampleRate } = wave.decoded;
  const centerIndex = Math.floor(audio.currentTime * sampleRate);
  const windowSize = Math.max(48, Math.floor(sampleRate * 0.052));
  const raw = sampleEnergy(data, centerIndex - windowSize / 2, centerIndex + windowSize / 2, 2);
  const gated = raw < 0.045 ? raw * 0.35 : raw;
  const smoothing = gated > wave.level ? 0.34 : 0.14;
  wave.level += (gated - wave.level) * smoothing;
  return wave.level;
}

function barShape(index, count) {
  const position = index / Math.max(1, count - 1);
  const centerLift = Math.sin(position * Math.PI);
  const variation = columnNoise(index);
  return clampNumber(0.34 + centerLift * 0.2 + variation * 0.46, 0.32, 1);
}

function rebuildWaveFrame(width, intensity) {
  if (!audio || !wave.decoded || wave.player !== audio) {
    wave.frame = [];
    return;
  }

  const columns = Math.max(24, Math.ceil(width / 7));
  const { data, sampleRate } = wave.decoded;
  const centerIndex = Math.floor(audio.currentTime * sampleRate);
  const baseWindow = Math.max(56, Math.floor(sampleRate * 0.074));
  const transientWindow = Math.max(18, Math.floor(sampleRate * 0.024));
  const bodyLevel = sampleEnergy(data, centerIndex - baseWindow / 2, centerIndex + baseWindow / 2);
  const transientLevel = sampleEnergy(data, centerIndex - transientWindow / 2, centerIndex + transientWindow / 2);
  const currentLevel = clampNumber(bodyLevel * 0.72 + transientLevel * 0.28, 0, 1);
  const previous = wave.frame.length === columns ? wave.frame : new Array(columns).fill(0);
  const nowSeconds = performance.now() / 1000;
  const nextFrame = [];

  for (let column = 0; column < columns; column += 1) {
    const position = column / Math.max(1, columns - 1);
    const centerLift = Math.sin(position * Math.PI);
    const jitter = (columnNoise(column, 2) - 0.5) * sampleRate * 0.022;
    const localCenter = centerIndex + Math.round(jitter);
    const localWindow = Math.max(14, Math.floor(sampleRate * (0.018 + columnNoise(column, 3) * 0.02)));
    const level = sampleEnergy(data, localCenter - localWindow / 2, localCenter + localWindow / 2);
    const wobbleRate = 0.95 + columnNoise(column, 4) * 1.55;
    const wobblePhase = columnNoise(column, 5) * Math.PI * 2;
    const wobble = 0.88 + Math.sin(nowSeconds * wobbleRate + wobblePhase) * (0.04 + intensity * 0.08);
    const gated = level < 0.055 && currentLevel < 0.06 ? level * 0.36 : level;
    const shaped = clampNumber(
      (currentLevel * 0.42 + gated * 0.48) * (0.58 + barShape(column, columns) * 0.28) * wobble
        + centerLift * intensity * 0.026,
      0,
      1
    );
    const target = clampNumber(Math.pow(shaped, 1.42), 0.012, 0.84);
    const prior = previous[column] || 0;
    const smoothing = target > prior ? 0.42 : 0.16;
    nextFrame.push(prior + (target - prior) * smoothing);
  }

  wave.frame = nextFrame;
}

function compactWaveformBuffer(decoded) {
  const source = decoded.getChannelData(0);
  const sourceRate = decoded.sampleRate;
  const targetLength = Math.max(1, Math.ceil(decoded.duration * WAVEFORM_SAMPLE_RATE));
  const data = new Float32Array(targetLength);

  for (let index = 0; index < targetLength; index += 1) {
    const start = Math.floor(index * sourceRate / WAVEFORM_SAMPLE_RATE);
    const end = Math.min(source.length, Math.max(start + 1, Math.floor((index + 1) * sourceRate / WAVEFORM_SAMPLE_RATE)));
    let strongest = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      const sample = source[sourceIndex] || 0;
      if (Math.abs(sample) > Math.abs(strongest)) {
        strongest = sample;
      }
    }
    data[index] = strongest;
  }

  return { data, sampleRate: WAVEFORM_SAMPLE_RATE };
}

function fillRoundedBar(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, width, height);
}

function drawVisualizerBars(ctx, bounds, intensity, active) {
  const frame = active && wave.frame.length
    ? wave.frame
    : Array.from({ length: Math.max(24, Math.ceil(bounds.width / 7)) }, (_value, index) => {
        const nowSeconds = performance.now() / 1000;
        const rate = 0.55 + columnNoise(index, 6) * 0.8;
        const phase = columnNoise(index, 7) * Math.PI * 2;
        return Math.sin(nowSeconds * rate + phase) * 0.018;
      });
  const barCount = frame.length;
  const step = bounds.width / Math.max(1, barCount);
  const barWidth = clampNumber(step * 0.56, 2, 5);
  const baseY = bounds.height - 5;
  const maxHeight = Math.max(4, bounds.height - 10);

  ctx.shadowBlur = active ? 4 + intensity * 2 : 0;
  ctx.shadowColor = "rgba(238, 241, 242, 0.28)";
  for (let index = 0; index < barCount; index += 1) {
    const sample = Math.abs(frame[index] || 0);
    const idle = active ? 0 : 0.045 + Math.abs(frame[index] || 0);
    const energy = active
      ? clampNumber(sample, 0.025, 0.92)
      : clampNumber(idle, 0.03, 0.11);
    const eased = active ? Math.pow(energy, 1.08) : energy;
    const height = clampNumber(eased * maxHeight, active ? 3 : 2, maxHeight * (active ? 0.9 : 1));
    const x = index * step + (step - barWidth) / 2;
    const y = baseY - height;
    const alpha = active ? clampNumber(0.26 + eased * 0.54, 0.3, 0.82) : 0.22;
    ctx.fillStyle = `rgba(232, 238, 242, ${alpha})`;
    fillRoundedBar(ctx, x, y, barWidth, height, Math.min(2.5, barWidth / 2));
  }
  ctx.shadowBlur = 0;
}

function resetWaveformData(player = null) {
  wave.player = player;
  wave.decoded = null;
  wave.frame = [];
  wave.level = 0;
  wave.loading = false;
}

async function loadWaveformData(clip, player) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor || !clip?.audioUrl) {
    return;
  }

  try {
    wave.loading = true;
    wave.audioContext ||= new AudioContextConstructor();
    const response = await fetch(clip.audioUrl);
    const bytes = await response.arrayBuffer();
    const decoded = await wave.audioContext.decodeAudioData(bytes);
    if (audio === player && wave.player === player) {
      wave.decoded = compactWaveformBuffer(decoded);
    }
  } catch (_error) {
    if (audio === player && wave.player === player) {
      wave.decoded = null;
    }
  } finally {
    if (wave.player === player) {
      wave.loading = false;
    }
  }
}

function clearWaveformSchedule() {
  if (wave.nextFrame !== null) {
    cancelAnimationFrame(wave.nextFrame);
    wave.nextFrame = null;
  }
  if (wave.nextTimer !== null) {
    clearTimeout(wave.nextTimer);
    wave.nextTimer = null;
  }
}

function requestWaveformFrame() {
  wave.nextFrame = requestAnimationFrame(() => {
    wave.nextFrame = null;
    drawWaveform();
  });
}

function scheduleWaveform(active) {
  const delay = document.hidden
    ? WAVEFORM_HIDDEN_FRAME_MS
    : active
      ? 0
      : WAVEFORM_IDLE_FRAME_MS;

  if (delay <= 0) {
    requestWaveformFrame();
    return;
  }

  wave.nextTimer = window.setTimeout(() => {
    wave.nextTimer = null;
    requestWaveformFrame();
  }, delay);
}

function drawWaveform() {
  if (document.hidden) {
    wave.level *= 0.5;
    document.body.dataset.voiceActive = "false";
    scheduleWaveform(false);
    return;
  }

  const canvas = nodes.waveform;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width * window.devicePixelRatio));
  const height = Math.max(1, Math.floor(bounds.height * window.devicePixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = wave.context;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, bounds.width, bounds.height);

  const center = bounds.height / 2;
  const intensity = waveIntensity();
  document.body.dataset.voiceActive = String(intensity > 0.018);
  updateSeekProgress();

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(238, 241, 242, 0.08)";
  ctx.beginPath();
  ctx.moveTo(0, center);
  ctx.lineTo(bounds.width, center);
  ctx.stroke();

  const active = intensity > 0.012 && wave.decoded && wave.player === audio;
  if (active) {
    rebuildWaveFrame(bounds.width, intensity);
  }
  drawVisualizerBars(ctx, bounds, intensity, active);

  scheduleWaveform(active || audioPlaying || wave.loading || intensity > 0.018);
}

function showState(nextState) {
  state = nextState || {};
  nodes.edgeVoice.replaceChildren(...(state.edgeVoices || []).map((voice) => option(voice.id, `${voice.label} - ${voice.locale}`)));
  nodes.windowsVoice.replaceChildren(
    option("", "Auto Windows voice"),
    ...(state.windowsVoices || []).map((voice) => {
      const details = [voice.locale, voice.gender].filter(Boolean).join(" ");
      return option(voice.id, details ? `${voice.label} - ${details}` : voice.label);
    })
  );
  const supportedEngines = state.supportedEngines || ["edge", "windows"];
  for (const engineOption of nodes.engine.options) {
    engineOption.disabled = !supportedEngines.includes(engineOption.value);
  }

  const savedLocal = readSavedSettings();
  if (savedLocal.engine && !supportedEngines.includes(savedLocal.engine)) {
    savedLocal.engine = state.settings?.engine || supportedEngines[0] || "windows";
  }
  const saved = { ...(state.settings || {}), ...savedLocal };
  syncEnabledControls(Boolean(saved.enabled));
  nodes.engine.value = saved.engine || "edge";
  nodes.edgeVoice.value = saved.edgeVoice || "en-US-AvaMultilingualNeural";
  nodes.edgePitch.value = saved.edgePitch ?? 0;
  nodes.windowsMode.value = saved.windowsVoiceMode || state.settings?.windowsVoiceMode || "auto";
  nodes.windowsVoice.value = saved.windowsVoice || state.settings?.windowsVoice || "";
  nodes.speed.value = saved.speed || 1.05;
  nodes.volume.value = saved.volume ?? 0.85;
  syncEngineControls();
  syncRangeLabels();
  showSession(state.session);
  showUsage(state.usage);
  showActivity(state.activity);
}

function pathName(value) {
  return text(value).split(/[\\/]/).filter(Boolean).pop() || "";
}

function sessionLabel(session) {
  if (!session) {
    return {
      project: "No project",
      title: "No active Codex session",
      tooltip: "QDex will attach automatically when a Codex session is visible."
    };
  }

  const project = pathName(session.cwd) || "Project";
  const title = session.name || project;
  return {
    project,
    title,
    tooltip: session.cwd ? `${title} - ${session.cwd}` : title
  };
}

function showSession(session) {
  const label = sessionLabel(session);
  nodes.projectName.textContent = "CODEX";
  nodes.sessionTitle.textContent = label.title;
  nodes.sessionTitle.title = label.tooltip;
  nodes.sessionFolder.textContent = session?.cwd || "-";
  nodes.sessionLog.textContent = session?.sourcePath || "-";
}

function showStatus(nextStatus) {
  statusState = nextStatus?.state || "info";
  if (statusState === "error" || statusState === "warning" || statusState === "off") {
    setSessionActive(false);
    showActivity({
      detail: nextStatus?.message || "",
      state: statusState,
      title: statusState === "error" ? "Reader error" : statusState === "warning" ? "Reader warning" : "Reader status"
    });
    return;
  }

  if (statusState === "ready") {
    activityState = null;
    setSessionActive(false);
    showIdleMessage();
    return;
  }

  if (!activityState) {
    showActivity({
      detail: nextStatus?.message || "",
      state: statusState,
      title: statusState === "working" ? "Thinking" : "Codex state"
    });
  } else {
    setSessionActive(activityLooksActive(statusState) || activityLooksActive(activityState.state));
  }
}

function syncRangeLabels() {
  nodes.speedValue.textContent = Number(nodes.speed.value).toFixed(2);
  nodes.edgePitchValue.textContent = `${Number(nodes.edgePitch.value) || 0}Hz`;
  nodes.volumeValue.textContent = Number(nodes.volume.value).toFixed(2);
}

function currentSpeechSpeed() {
  return clampNumber(Number(nodes.speed.value) || 1, Number(nodes.speed.min) || 0.7, Number(nodes.speed.max) || 1.5);
}

function playbackRateForClip(clip = activeClip) {
  const baseSpeed = Number(clip?.speechSpeed) || currentSpeechSpeed();
  return clampNumber(currentSpeechSpeed() / baseSpeed, 0.5, 2);
}

function applyPlaybackRate() {
  if (audio) {
    audio.playbackRate = playbackRateForClip(activeClip);
  }
}

function updateTransportButtons() {
  const isPlaying = Boolean(audio && !audio.paused && !audio.ended);
  nodes.playPause.dataset.mode = isPlaying ? "pause" : "play";
  nodes.playPause.title = isPlaying ? "Pause" : "Play";
  nodes.playPause.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  nodes.readAgain.disabled = !lastOutputText.trim();
}

function updateSeekProgress() {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    nodes.waveSeek.style.setProperty("--seek-progress", "0%");
    nodes.waveSeek.title = lastOutputText.trim() ? "Replay, then click here to seek within the voice track" : "No voice track loaded";
    return;
  }

  const ratio = clampNumber(audio.currentTime / audio.duration, 0, 1);
  nodes.waveSeek.style.setProperty("--seek-progress", `${ratio * 100}%`);
  nodes.waveSeek.title = `Seek ${formatDuration(audio.currentTime * 1000)} / ${formatDuration(audio.duration * 1000)}`;
}

function seekAudioByRatio(ratio) {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return false;
  }

  audio.currentTime = clampNumber(ratio, 0, 1) * audio.duration;
  if (audio.paused) {
    void audio.play().catch((error) => showStatus({ state: "error", message: error.message }));
  }
  updateSeekProgress();
  updateTransportButtons();
  return true;
}

function seekRatioFromEvent(event) {
  const rect = nodes.waveSeek.getBoundingClientRect();
  return clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

async function seekWave(event) {
  const ratio = seekRatioFromEvent(event);
  if (seekAudioByRatio(ratio)) {
    return;
  }

  if (!lastOutputText.trim()) {
    return;
  }

  pendingSeekRatio = ratio;
  await readAgain();
}

function setSpeedValue(value) {
  const next = clampNumber(value, Number(nodes.speed.min) || 0.7, Number(nodes.speed.max) || 1.5);
  nodes.speed.value = next.toFixed(2);
  syncRangeLabels();
  applyPlaybackRate();
}

async function adjustSpeed(delta) {
  setSpeedValue(currentSpeechSpeed() + delta);
  await setSettings();
}

function showOutput(output) {
  lastOutputText = text(output.text).trim() || lastOutputText;
  updateTransportButtons();
  const item = document.createElement("li");
  item.innerHTML = `<time>${new Date(output.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><pre>${escapeHtml(output.text)}</pre>`;
  nodes.outputs.prepend(item);
  while (nodes.outputs.children.length > 12) {
    nodes.outputs.lastElementChild.remove();
  }
}

function playNext() {
  if (audio || !audioQueue.length) {
    return;
  }
  const clip = audioQueue.shift();
  const player = new Audio(clip.audioUrl);
  player.volume = Math.min(1, Math.max(0, Number(clip.volume ?? nodes.volume.value)));
  activeClip = clip;
  audio = player;
  audioPlaying = false;
  applyPlaybackRate();
  resetWaveformData(player);
  void loadWaveformData(clip, player);
  const markPlaying = () => {
    if (audio === player) {
      audioPlaying = true;
      updateTransportButtons();
    }
  };
  const markNotPlaying = () => {
    if (audio === player) {
      audioPlaying = false;
      updateTransportButtons();
    }
  };
  const finish = () => {
    if (audio !== player) {
      return;
    }
    if (clip.playbackId) {
      void bridge?.finishSpeech?.(clip.playbackId);
    }
    audioPlaying = false;
    activeClip = null;
    resetWaveformData();
    audio = null;
    player.src = "";
    updateTransportButtons();
    playNext();
  };
  player.addEventListener("play", markPlaying);
  player.addEventListener("playing", markPlaying);
  player.addEventListener("pause", markNotPlaying);
  player.addEventListener("waiting", markNotPlaying);
  player.addEventListener("ended", finish, { once: true });
  player.addEventListener("error", finish, { once: true });
  player.addEventListener("loadedmetadata", () => {
    if (audio !== player || pendingSeekRatio === null) {
      return;
    }
    player.currentTime = clampNumber(pendingSeekRatio, 0, 1) * Math.max(0, player.duration || 0);
    pendingSeekRatio = null;
    updateSeekProgress();
  }, { once: true });
  player.play().catch(finish);
}

function stopAudio() {
  audioQueue.length = 0;
  audioPlaying = false;
  activeClip = null;
  pendingSeekRatio = null;
  resetWaveformData();
  if (audio) {
    const player = audio;
    audio = null;
    player.pause();
    player.src = "";
  }
  updateTransportButtons();
  updateSeekProgress();
}

async function skipCurrentRead() {
  stopAudio();
  try {
    state = await bridge?.skipSpeech?.();
  } catch (error) {
    showStatus({ state: "error", message: error.message });
  }
}

async function setSettings() {
  if (!bridge) {
    return;
  }
  saveSettings();
  syncEngineControls();
  state = await bridge.setSettings(currentSettings());
  syncEngineControls();
  applyPlaybackRate();
}

async function readAgain() {
  const textToRead = lastOutputText.trim();
  if (!textToRead || !bridge?.readText) {
    return;
  }

  stopAudio();
  try {
    state = await bridge.readText({ text: textToRead, settings: currentSettings() });
  } catch (error) {
    showStatus({ state: "error", message: error.message });
  }
}

async function playOrPause() {
  if (audio) {
    if (audio.paused) {
      await audio.play().catch((error) => showStatus({ state: "error", message: error.message }));
    } else {
      audio.pause();
    }
    updateTransportButtons();
    return;
  }

  if (audioQueue.length) {
    playNext();
    updateTransportButtons();
    return;
  }

  await readAgain();
}

async function testVoice() {
  try {
    state = await bridge.testVoice(currentSettings());
  } catch (error) {
    showStatus({ state: "error", message: error.message });
  }
}

function applyEnabledChange(event) {
  syncEnabledControls(event.currentTarget.checked);
  setSettings();
}

nodes.speed.addEventListener("input", () => {
  syncRangeLabels();
  applyPlaybackRate();
});
nodes.speed.addEventListener("change", setSettings);
for (const slider of [nodes.volume, nodes.edgePitch]) {
  slider.addEventListener("input", syncRangeLabels);
  slider.addEventListener("change", setSettings);
}
nodes.enabled.addEventListener("change", applyEnabledChange);
nodes.engine.addEventListener("change", () => {
  syncEngineControls();
  setSettings();
});
nodes.edgeVoice.addEventListener("change", setSettings);
nodes.windowsMode.addEventListener("change", () => {
  syncEngineControls();
  setSettings();
});
nodes.windowsVoice.addEventListener("change", setSettings);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearWaveformSchedule();
    scheduleWaveform(true);
  }
});
nodes.faster.addEventListener("click", () => void adjustSpeed(SPEED_STEP));
nodes.minimize.addEventListener("click", () => bridge?.hideToTray?.());
nodes.playPause.addEventListener("click", playOrPause);
nodes.readAgain.addEventListener("click", readAgain);
nodes.skipRead.addEventListener("click", skipCurrentRead);
nodes.settingsClose.addEventListener("click", () => setSettingsOpen(false));
nodes.settingsOpen.addEventListener("click", () => setSettingsOpen(nodes.settingsPanel.hidden));
nodes.slower.addEventListener("click", () => void adjustSpeed(-SPEED_STEP));
nodes.test.addEventListener("click", testVoice);
nodes.waveSeek.addEventListener("click", (event) => void seekWave(event));

showUsage(null);
showSession(null);
showActivity({ state: "starting", title: "Starting up", detail: "Loading QDex overlay" });
updateTransportButtons();
setInterval(() => {
  showUsage(usageState);
  if (!activityState) {
    showIdleMessage();
  }
}, 30000);
scheduleWaveform(false);

if (bridge) {
  bridge.onActivity(showActivity);
  bridge.onStatus(showStatus);
  bridge.onOutput(showOutput);
  bridge.onSession(showSession);
  bridge.onStopAudio(stopAudio);
  bridge.onUsage(showUsage);
  bridge.onAudio((clip) => {
    if (audioQueue.length >= MAX_AUDIO_QUEUE) {
      audioQueue.shift();
    }
    audioQueue.push(clip);
    playNext();
  });
  bridge.getState()
    .then(async (nextState) => {
      showState(nextState);
      await setSettings();
    })
    .catch((error) => showStatus({ state: "error", message: error.message }));
} else {
  showState({
    edgeVoices: [{ id: "en-US-AvaMultilingualNeural", label: "Ava Multilingual", locale: "en-US" }],
    settings: {
      enabled: true,
      engine: "edge",
      edgeVoice: "en-US-AvaMultilingualNeural",
      edgePitch: 0,
      windowsVoiceMode: "auto",
      windowsVoice: "",
      speed: 1.05,
      volume: 0.85
    },
    session: null,
    activity: { state: "info", title: "Open QDex app", detail: "Bridge is not available" }
  });
  nodes.test.disabled = true;
  showStatus({ state: "info", message: "Open QDex to listen to Codex output." });
}
