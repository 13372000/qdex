const bridge = window.codexReader;
const nodes = {
  contextCluster: document.querySelector("#context-cluster"),
  contextGauge: document.querySelector("#context-gauge"),
  download: document.querySelector("#download"),
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
  steps: document.querySelector("#steps"),
  stepsValue: document.querySelector("#steps-value"),
  test: document.querySelector("#test"),
  usageCluster: document.querySelector("#usage-cluster"),
  usageGauge: document.querySelector("#usage-gauge"),
  usagePercent: document.querySelector("#usage-percent"),
  voice: document.querySelector("#voice"),
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
const MAX_AUDIO_QUEUE = 32;
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
    voice: nodes.voice.value || "F1",
    speed: nodes.speed.value,
    totalStep: nodes.steps.value,
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

  const canTest = engine === "edge" || engine === "windows" || Boolean(state?.assetsReady);
  const needsAssets = engine === "supertonic";
  nodes.test.disabled = !canTest;
  nodes.download.disabled = needsAssets ? Boolean(state?.assetsReady) : true;
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
    wave.level *= 0.72;
    return wave.level;
  }

  const { data, sampleRate } = wave.decoded;
  const centerIndex = Math.floor(audio.currentTime * sampleRate);
  const windowSize = Math.max(192, Math.floor(sampleRate * 0.032));
  const start = clampNumber(centerIndex - Math.floor(windowSize / 2), 0, Math.max(0, data.length - 1));
  const end = clampNumber(start + windowSize, start + 1, data.length);
  let sum = 0;
  let peak = 0;
  let count = 0;

  for (let index = start; index < end; index += 4) {
    const sample = data[index] || 0;
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    count += 1;
  }

  const rms = Math.sqrt(sum / Math.max(1, count));
  const raw = clampNumber((rms * 8.2) + (peak * 0.55), 0, 1);
  const smoothing = raw > wave.level ? 0.62 : 0.24;
  wave.level += (raw - wave.level) * smoothing;
  return wave.level;
}

function rebuildWaveFrame(width) {
  if (!audio || !wave.decoded || wave.player !== audio) {
    wave.frame = [];
    return;
  }

  const columns = Math.max(48, Math.ceil(width / 4) + 1);
  const { data, sampleRate } = wave.decoded;
  const centerIndex = Math.floor(audio.currentTime * sampleRate);
  const sourceSpan = Math.max(columns * 5, Math.floor(sampleRate * 0.09));
  const sourceStart = clampNumber(centerIndex - Math.floor(sourceSpan / 2), 0, Math.max(0, data.length - 1));
  const nextFrame = [];

  for (let column = 0; column < columns; column += 1) {
    const mirrored = column <= columns / 2 ? column : columns - column - 1;
    const position = mirrored / Math.max(1, Math.floor(columns / 2));
    const sourceIndex = clampNumber(
      sourceStart + Math.floor(position * sourceSpan),
      0,
      Math.max(0, data.length - 1)
    );
    let total = 0;
    let count = 0;
    for (let offset = -10; offset <= 10; offset += 2) {
      const index = clampNumber(sourceIndex + offset, 0, Math.max(0, data.length - 1));
      total += data[index] || 0;
      count += 1;
    }
    const edgeFade = Math.sin((column / Math.max(1, columns - 1)) * Math.PI);
    nextFrame.push((total / Math.max(1, count)) * edgeFade);
  }

  wave.frame = nextFrame;
}

function waveformSampleAt(x, width) {
  if (!wave.frame.length) {
    return 0;
  }

  const exact = clampNumber((x / Math.max(1, width)) * (wave.frame.length - 1), 0, wave.frame.length - 1);
  const left = Math.floor(exact);
  const right = Math.min(wave.frame.length - 1, left + 1);
  const mix = exact - left;
  const audioSample = wave.frame[left] * (1 - mix) + wave.frame[right] * mix;
  return clampNumber(audioSample, -1, 1);
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
      wave.decoded = {
        data: decoded.getChannelData(0),
        sampleRate: decoded.sampleRate
      };
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

function drawWaveform() {
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
  ctx.strokeStyle = "rgba(220, 226, 230, 0.08)";
  for (let y = 10; y < bounds.height; y += 14) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(bounds.width, y);
    ctx.stroke();
  }

  if (intensity <= 0.012 || !wave.decoded || wave.player !== audio) {
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = statusState === "error" ? "rgba(232, 135, 135, 0.66)" : "rgba(213, 220, 225, 0.32)";
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(bounds.width, center);
    ctx.stroke();
    requestAnimationFrame(drawWaveform);
    return;
  }

  ctx.lineWidth = 2;
  ctx.shadowBlur = 8;
  ctx.shadowColor = "rgba(220, 226, 230, 0.42)";
  ctx.strokeStyle = "rgba(232, 238, 242, 0.88)";
  ctx.beginPath();
  let smoothedY = center;
  rebuildWaveFrame(bounds.width);
  for (let x = 0; x <= bounds.width; x += 4) {
    const sample = waveformSampleAt(x, bounds.width);
    const amplified = clampNumber(sample * (2.8 + intensity * 4.8), -1, 1);
    const targetY = clampNumber(center + amplified * bounds.height * 0.45, 4, bounds.height - 4);
    smoothedY += (targetY - smoothedY) * 0.58;
    if (x === 0) {
      ctx.moveTo(x, smoothedY);
    } else {
      ctx.lineTo(x, smoothedY);
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  requestAnimationFrame(drawWaveform);
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
  nodes.voice.replaceChildren(...(state.voices || []).map(option));

  const saved = { ...(state.settings || {}), ...readSavedSettings() };
  syncEnabledControls(Boolean(saved.enabled));
  nodes.engine.value = saved.engine || "edge";
  nodes.edgeVoice.value = saved.edgeVoice || "en-US-AvaMultilingualNeural";
  nodes.edgePitch.value = saved.edgePitch ?? 0;
  nodes.windowsMode.value = saved.windowsVoiceMode || state.settings?.windowsVoiceMode || "auto";
  nodes.windowsVoice.value = saved.windowsVoice || state.settings?.windowsVoice || "";
  nodes.voice.value = saved.voice || "F1";
  nodes.speed.value = saved.speed || 1.05;
  nodes.steps.value = saved.totalStep || 4;
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
  nodes.stepsValue.textContent = nodes.steps.value;
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

async function downloadAssets() {
  nodes.download.disabled = true;
  try {
    showState(await bridge.downloadAssets());
    await setSettings();
  } catch (error) {
    showStatus({ state: "error", message: error.message });
    nodes.download.disabled = false;
  }
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
for (const slider of [nodes.steps, nodes.volume, nodes.edgePitch]) {
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
nodes.voice.addEventListener("change", setSettings);
nodes.download.addEventListener("click", downloadAssets);
nodes.faster.addEventListener("click", () => void adjustSpeed(SPEED_STEP));
nodes.minimize.addEventListener("click", () => bridge?.minimize());
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
requestAnimationFrame(drawWaveform);

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
    assetsReady: false,
    modelLoaded: false,
    edgeVoices: [{ id: "en-US-AvaMultilingualNeural", label: "Ava Multilingual", locale: "en-US" }],
    voices: ["F1", "F2", "M1", "M2"],
    settings: {
      enabled: true,
      engine: "edge",
      edgeVoice: "en-US-AvaMultilingualNeural",
      edgePitch: 0,
      windowsVoiceMode: "auto",
      windowsVoice: "",
      voice: "F1",
      speed: 1.05,
      totalStep: 4,
      volume: 0.85
    },
    session: null,
    activity: { state: "info", title: "Open Electron app", detail: "Bridge is not available" }
  });
  nodes.download.disabled = true;
  nodes.test.disabled = true;
  showStatus({ state: "info", message: "Open the Electron app to listen to Codex output." });
}
