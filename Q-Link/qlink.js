import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transcribeAudioBuffer } from "./whisper-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const FALLBACK_ENV_PATH = path.join(ROOT_DIR, "AGENT_CODEX", ".env");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 3900;
const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 5000;
const TELEGRAM_TYPING_INTERVAL_MS = 4500;
const QDEX_MAX_PENDING_RELAYS = 12;
const ACK_MESSAGES = [
  "On it.",
  "Got it. Sending it to Codex.",
  "I am passing that to Codex.",
  "One moment.",
  "I am sending that now.",
  "Understood.",
  "I have got it.",
  "Working on the handoff.",
  "I will put that in Codex.",
  "Sending it over."
];

loadEnvFile(path.join(__dirname, ".env"));
loadEnvFile(FALLBACK_ENV_PATH, { onlyMissing: true });

const config = buildConfig();
const pidPath = path.join(config.dataDir, "qlink.pid");
const offsetPath = path.join(config.dataDir, "telegram-offset.json");
let telegramOffset = (await readJsonFile(offsetPath, {})).offset || 0;
let activeInjection = false;
let shuttingDown = false;
let qdexBroadcastOffset = 0;
let qdexBroadcastCarry = "";
const pendingQdexAudioRelays = [];
const sentQdexAudioIds = new Set();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error(`Q-Link fatal: ${formatError(error)}`);
  void shutdown("fatal", 1);
});

async function main() {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN absent. Mets-le dans Q-Link/.env ou laisse Q-Link lire AGENT_CODEX/.env.");
  }

  await fsp.mkdir(config.dataDir, { recursive: true });
  await ensureSingleInstance();
  await writeTextFile(pidPath, String(process.pid));

  console.log("Q-Link started.");
  console.log(
    config.allowedChatIds.size
      ? `Telegram allowed chats: ${[...config.allowedChatIds].join(", ")}`
      : "Telegram allowed chats: all"
  );
  console.log(`Target process names: ${config.targetProcessNames}`);
  console.log(`Window title pattern: ${config.windowTitlePattern}`);
  await startQdexBroadcastWatcher(baseUrlForTelegram());
  console.log("Q-Link is polling Telegram.");

  await pollTelegram();
}

async function pollTelegram() {
  const baseUrl = baseUrlForTelegram();

  while (!shuttingDown) {
    try {
      const updates = await telegramRequest(baseUrl, "getUpdates", {
        offset: telegramOffset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message"]
      }, {
        timeoutMs: (POLL_TIMEOUT_SECONDS + 10) * 1000
      });

      for (const update of updates) {
        telegramOffset = update.update_id + 1;
        await writeJsonFile(offsetPath, { offset: telegramOffset });
        void handleTelegramUpdate(baseUrl, update).catch((error) => {
          console.error(`Telegram update error: ${formatError(error)}`);
        });
      }
    } catch (error) {
      console.error(`Telegram polling error: ${formatError(error)}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function handleTelegramUpdate(baseUrl, update) {
  const message = update?.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : "";
  const replyOptions = buildTelegramReplyOptions(message);

  if (!chatId) {
    return;
  }

  if (config.allowedChatIds.size && !config.allowedChatIds.has(chatId)) {
    await sendTelegramText(
      baseUrl,
      chatId,
      `Access denied.\nchat_id=${chatId}\nAjoute cet id dans TELEGRAM_ALLOWED_CHAT_IDS.`,
      replyOptions
    );
    return;
  }

  const extracted = await extractTelegramPrompt(baseUrl, chatId, message, replyOptions);
  if (!extracted.text) {
    await sendTelegramText(baseUrl, chatId, "Message texte ou vocal requis.", replyOptions);
    return;
  }

  const parsed = parseQLinkCommand(extracted.text);
  if (!parsed) {
    return;
  }

  switch (parsed.command) {
    case "help":
      await sendTelegramText(baseUrl, chatId, buildHelpText(), replyOptions);
      return;

    case "status":
      await sendTelegramText(baseUrl, chatId, buildStatusText());
      return;

    case "prompt":
      await handlePrompt(baseUrl, chatId, parsed.args, {
        inputKind: extracted.kind,
        telegramReplyOptions: replyOptions,
        ackAlreadySent: extracted.ackSent
      });
      return;

    default:
      await sendTelegramText(baseUrl, chatId, `Commande inconnue. Utilise ${config.commandPrefix} help.`, replyOptions);
  }
}

function buildTelegramReplyOptions(message) {
  if (!config.telegramReplyToMessages || !message?.message_id) {
    return {};
  }

  return {
    replyToMessageId: message.message_id
  };
}

async function extractTelegramPrompt(baseUrl, chatId, message, replyOptions = {}) {
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (text) {
    return { kind: "text", text, ackSent: false };
  }

  const audio = message?.voice || message?.audio;
  if (!audio?.file_id) {
    return { kind: "unknown", text: "", ackSent: false };
  }

  const stopTyping = startTelegramTyping(baseUrl, chatId);
  await sendTelegramAck(baseUrl, chatId, replyOptions);

  try {
    const audioStartedAt = Date.now();
    const audioBuffer = await downloadTelegramFile(baseUrl, config.telegramToken, audio.file_id);
    let whisperTimings = {};
    const transcript = await transcribeAudioBuffer(audioBuffer, {
      onTiming(timings) {
        whisperTimings = timings || {};
      }
    });
    const clean = transcript.trim();

    console.log(
      [
        "Telegram voice transcribed",
        `chat=${chatId}`,
        `chars=${clean.length}`,
        `totalMs=${Date.now() - audioStartedAt}`,
        `whisperMs=${whisperTimings.whisperMs ?? "unknown"}`
      ].join(" ")
    );

    if (!clean) {
      await sendTelegramText(baseUrl, chatId, "Transcription vide. Reessaie.", replyOptions);
      return { kind: "voice", text: "", ackSent: true };
    }

    return { kind: "voice", text: clean, ackSent: true };
  } catch (error) {
    console.error(`Telegram voice transcription failed: ${formatError(error)}`);
    await sendTelegramText(baseUrl, chatId, `Erreur transcription: ${formatError(error)}`, replyOptions);
    return { kind: "voice", text: "", ackSent: true };
  } finally {
    stopTyping();
  }
}

async function handlePrompt(baseUrl, chatId, prompt, options = {}) {
  if (!prompt) {
    await sendTelegramText(baseUrl, chatId, `Usage: ${config.commandPrefix} <prompt>`, options.telegramReplyOptions);
    return;
  }

  if (activeInjection) {
    await sendTelegramText(baseUrl, chatId, "Q-Link est deja en train d'injecter un prompt.", options.telegramReplyOptions);
    return;
  }

  if (!options.ackAlreadySent) {
    await sendTelegramAck(baseUrl, chatId, options.telegramReplyOptions);
  }

  activeInjection = true;
  const stopTyping = startTelegramTyping(baseUrl, chatId);

  try {
    const result = await injectIntoCodexDesktop(prompt);
    registerPendingQdexAudioRelay({
      chatId,
      replyToMessageId: options.telegramReplyOptions?.replyToMessageId || null,
      inputKind: options.inputKind || "text",
      prompt
    });
    console.log(
      [
        "Prompt injected",
        `chat=${chatId}`,
        `chars=${prompt.length}`,
        `process=${result.processName || "unknown"}`,
        `pid=${result.processId || "unknown"}`,
        `title=${JSON.stringify(result.windowTitle || "")}`
      ].join(" ")
    );
  } catch (error) {
    await sendTelegramText(baseUrl, chatId, `Erreur injection Codex Desktop\n${formatError(error)}`, options.telegramReplyOptions);
  } finally {
    stopTyping();
    activeInjection = false;
  }
}

async function injectIntoCodexDesktop(prompt) {
  const id = crypto.randomUUID();
  const textPath = path.join(os.tmpdir(), `qlink-prompt-${id}.txt`);
  await fsp.writeFile(textPath, prompt, "utf8");

  try {
    return await runPowerShellJson(path.join(__dirname, "scripts", "inject-codex.ps1"), [
      "-TextPath",
      textPath,
      "-ProcessNames",
      config.targetProcessNames,
      "-WindowTitlePattern",
      config.windowTitlePattern,
      "-FocusDelayMs",
      String(config.focusDelayMs),
      "-AfterPasteDelayMs",
      String(config.afterPasteDelayMs),
      "-SubmitKeys",
      config.submitKeys,
      "-AutoSubmit",
      config.autoSubmit ? "1" : "0",
      "-ClickInput",
      config.clickInput ? "1" : "0",
      "-ClickXRatio",
      String(config.clickXRatio),
      "-ClickYMode",
      config.clickYMode,
      "-ClickBottomOffsetPx",
      String(config.clickBottomOffsetPx),
      "-ClickYRatio",
      String(config.clickYRatio),
      "-RestoreClipboard",
      config.restoreClipboard ? "1" : "0"
    ]);
  } finally {
    await fsp.unlink(textPath).catch(() => {});
  }
}

function runPowerShellJson(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args
    ], {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`PowerShell introuvable: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`PowerShell injection echec (code ${code}): ${stderr.trim() || stdout.trim()}`));
      }

      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch {
        resolve({ ok: true, raw: stdout.trim() });
      }
    });
  });
}

function parseQLinkCommand(text) {
  const compact = String(text || "").trim();
  if (!compact) {
    return null;
  }

  const [firstToken, ...rest] = compact.split(/\s+/);
  const normalizedToken = normalizeTelegramCommandToken(firstToken);
  const prefixToken = normalizeTelegramCommandToken(config.commandPrefix);

  if (normalizedToken === "/help" || normalizedToken === `${prefixToken}help`) {
    return { command: "help", args: rest.join(" ").trim() };
  }
  if (normalizedToken === "/status" || normalizedToken === `${prefixToken}status`) {
    return { command: "status", args: rest.join(" ").trim() };
  }
  if (normalizedToken === prefixToken) {
    return { command: "prompt", args: rest.join(" ").trim() };
  }
  if (normalizedToken.startsWith(`${prefixToken}@`)) {
    return { command: "prompt", args: rest.join(" ").trim() };
  }

  if (config.acceptFreeText) {
    return { command: "prompt", args: compact };
  }

  return null;
}

function buildHelpText() {
  return [
    "Q-Link",
    "",
    "<message texte> => colle le prompt dans Codex Desktop",
    "<message vocal> => transcription locale puis collage",
    "/status",
    "/help",
    "",
    `Alias explicite: ${config.commandPrefix} <prompt>`
  ].join("\n");
}

function buildStatusText() {
  return [
    "Q-Link status",
    `pid=${process.pid}`,
    `targetProcessNames=${config.targetProcessNames}`,
    `windowTitlePattern=${config.windowTitlePattern}`,
    `clickInput=${config.clickInput}`,
    `submitKeys=${config.submitKeys}`,
    `autoSubmit=${config.autoSubmit}`,
    `qdexAudio=${config.qdexEnabled ? config.qdexBroadcastPath : "off"}`,
    `pendingQdexAudio=${pendingQdexAudioRelays.length}`,
    activeInjection ? "activeInjection=yes" : "activeInjection=no"
  ].join("\n");
}

async function telegramRequest(baseUrl, method, payload, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || config.telegramRequestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(body.description || `Telegram API error on ${method}`);
    }

    return body.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Telegram API timeout on ${method} after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadTelegramFile(baseUrl, token, fileId) {
  const fileInfo = await telegramRequest(baseUrl, "getFile", { file_id: fileId });
  const fileUrl = `${TELEGRAM_API_BASE}/file/bot${token}/${fileInfo.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Impossible de telecharger le fichier Telegram (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function sendTelegramText(baseUrl, chatId, text, options = {}) {
  for (const chunk of chunkText(String(text || ""))) {
    await telegramRequest(baseUrl, "sendMessage", cleanObject({
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      reply_to_message_id: options?.replyToMessageId || null,
      allow_sending_without_reply: options?.replyToMessageId ? true : null
    }));
  }
}

async function telegramMultipartRequest(baseUrl, method, form) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.telegramRequestTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    const body = await response.json();

    if (!response.ok || !body.ok) {
      throw new Error(body.description || `Telegram API error on ${method}`);
    }

    return body.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Telegram API timeout on ${method} after ${config.telegramRequestTimeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramAck(baseUrl, chatId, options = {}) {
  await sendTelegramText(baseUrl, chatId, ACK_MESSAGES[crypto.randomInt(ACK_MESSAGES.length)], options);
}

function startTelegramTyping(baseUrl, chatId) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) {
      return;
    }

    try {
      await telegramRequest(baseUrl, "sendChatAction", {
        chat_id: chatId,
        action: "typing"
      });
    } catch (error) {
      console.warn(`Telegram typing action failed: ${formatError(error)}`);
    }

    if (!stopped) {
      timer = setTimeout(tick, TELEGRAM_TYPING_INTERVAL_MS);
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function sendTelegramAudio(baseUrl, chatId, audio, options = {}) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("audio", new Blob([audio.bytes], { type: audio.mimeType }), audio.filename);
  if (options.caption) {
    form.append("caption", options.caption);
  }
  if (options.replyToMessageId) {
    form.append("reply_to_message_id", String(options.replyToMessageId));
    form.append("allow_sending_without_reply", "true");
  }

  const result = await telegramMultipartRequest(baseUrl, "sendAudio", form);
  console.log(
    [
      "Telegram sendAudio sent",
      `chat=${chatId}`,
      `messageId=${result?.message_id ?? "unknown"}`,
      `bytes=${audio.bytes.length}`,
      options.replyToMessageId ? `replyTo=${options.replyToMessageId}` : null
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function registerPendingQdexAudioRelay({ chatId, replyToMessageId, inputKind, prompt }) {
  if (!config.qdexEnabled || !config.qdexSendAudioToTelegram || !chatId) {
    return;
  }

  const nowMs = Date.now();
  pendingQdexAudioRelays.push({
    id: crypto.randomUUID(),
    chatId: String(chatId),
    replyToMessageId: replyToMessageId || null,
    inputKind: inputKind || "text",
    promptPreview: String(prompt || "").trim().slice(0, 160),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + config.qdexRelayTimeoutMs
  });

  while (pendingQdexAudioRelays.length > QDEX_MAX_PENDING_RELAYS) {
    pendingQdexAudioRelays.shift();
  }

  console.log(`QDex audio relay pending chat=${chatId} input=${inputKind || "text"}`);
}

async function startQdexBroadcastWatcher(baseUrl) {
  if (!config.qdexEnabled || !config.qdexSendAudioToTelegram) {
    return;
  }

  await fsp.mkdir(path.dirname(config.qdexBroadcastPath), { recursive: true });
  qdexBroadcastOffset = await getFileSize(config.qdexBroadcastPath);
  console.log(`QDex audio watcher active: ${config.qdexBroadcastPath}`);

  void (async () => {
    while (!shuttingDown) {
      try {
        const lines = await readNewQdexBroadcastLines();
        for (const line of lines) {
          await handleQdexBroadcastLine(baseUrl, line);
        }
      } catch (error) {
        console.warn(`QDex audio watcher error: ${formatError(error)}`);
      }
      await sleep(config.qdexBroadcastPollMs);
    }
  })();
}

async function readNewQdexBroadcastLines() {
  const stat = await fsp.stat(config.qdexBroadcastPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!stat) {
    return [];
  }

  if (stat.size < qdexBroadcastOffset) {
    qdexBroadcastOffset = 0;
    qdexBroadcastCarry = "";
  }

  if (stat.size === qdexBroadcastOffset) {
    return [];
  }

  const handle = await fsp.open(config.qdexBroadcastPath, "r");
  try {
    const length = stat.size - qdexBroadcastOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, qdexBroadcastOffset);
    qdexBroadcastOffset = stat.size;

    const content = qdexBroadcastCarry + buffer.toString("utf8");
    const lines = content.split(/\r?\n/);
    qdexBroadcastCarry = lines.pop() || "";
    return lines.map((line) => line.trim()).filter(Boolean);
  } finally {
    await handle.close();
  }
}

async function handleQdexBroadcastLine(baseUrl, line) {
  let entry;
  try {
    entry = JSON.parse(line.replace(/^\uFEFF/, ""));
  } catch {
    return;
  }

  if (entry?.type !== "audio" || entry?.source !== "codex-log") {
    return;
  }

  const pendingRelay = takePendingQdexAudioRelay(entry);
  if (!pendingRelay) {
    return;
  }

  const clip = entry.clip || {};
  const playbackId = clip.playbackId || entry.id || crypto.randomUUID();
  if (sentQdexAudioIds.has(playbackId)) {
    return;
  }
  sentQdexAudioIds.add(playbackId);
  if (sentQdexAudioIds.size > 100) {
    sentQdexAudioIds.delete(sentQdexAudioIds.values().next().value);
  }

  const audio = decodeDataAudioUrl(clip.audioUrl);
  if (!audio) {
    console.warn("QDex audio watcher skipped entry without usable audioUrl.");
    return;
  }

  await sendTelegramAudio(baseUrl, pendingRelay.chatId, audio, {
    replyToMessageId: pendingRelay.replyToMessageId || null,
    caption: config.qdexAudioCaption
  });
}

function takePendingQdexAudioRelay(entry) {
  const nowMs = Date.now();
  for (let index = pendingQdexAudioRelays.length - 1; index >= 0; index -= 1) {
    if (pendingQdexAudioRelays[index].expiresAtMs <= nowMs) {
      pendingQdexAudioRelays.splice(index, 1);
    }
  }

  const entryMs = Date.parse(entry?.createdAt || "");
  const index = pendingQdexAudioRelays.findIndex((pending) => {
    if (!Number.isFinite(entryMs)) {
      return true;
    }
    return entryMs >= pending.createdAtMs - 2000;
  });

  if (index === -1) {
    return null;
  }

  const [pending] = pendingQdexAudioRelays.splice(index, 1);
  console.log(`QDex audio relay matched chat=${pending.chatId}`);
  return pending;
}

function decodeDataAudioUrl(value) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(value || ""));
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  const extension = audioExtensionForMimeType(mimeType);
  return {
    bytes,
    mimeType,
    filename: `qdex-reply.${extension}`
  };
}

function audioExtensionForMimeType(mimeType) {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  return "audio";
}

function buildConfig() {
  const dataDir = path.resolve(__dirname, env("QLINK_DATA_DIR", "data"));
  const qdexBridgeDir = path.resolve(env("QLINK_QDEX_BRIDGE_DIR", path.join(os.homedir(), ".qdex")));

  return {
    telegramToken: env("TELEGRAM_BOT_TOKEN", ""),
    allowedChatIds: parseCsvSet(env("TELEGRAM_ALLOWED_CHAT_IDS", "")),
    telegramReplyToMessages: parseBoolean(env("QLINK_TELEGRAM_REPLY_TO_MESSAGES", "1")),
    telegramRequestTimeoutMs: parsePositiveInteger(env("QLINK_TELEGRAM_REQUEST_TIMEOUT_MS", "30000"), 30000),
    acceptFreeText: parseBoolean(env("QLINK_ACCEPT_FREE_TEXT", "1")),
    commandPrefix: normalizeCommandPrefix(env("QLINK_COMMAND_PREFIX", "/qlink")),
    targetProcessNames: env("QLINK_TARGET_PROCESS_NAMES", "Codex"),
    windowTitlePattern: env("QLINK_WINDOW_TITLE_PATTERN", "Codex"),
    focusDelayMs: parsePositiveInteger(env("QLINK_FOCUS_DELAY_MS", "350"), 350),
    afterPasteDelayMs: parsePositiveInteger(env("QLINK_AFTER_PASTE_DELAY_MS", "150"), 150),
    submitKeys: env("QLINK_SUBMIT_KEYS", "{ENTER}"),
    autoSubmit: parseBoolean(env("QLINK_AUTO_SUBMIT", "1")),
    clickInput: parseBoolean(env("QLINK_CLICK_INPUT", "1")),
    clickXRatio: parseRatio(env("QLINK_CLICK_X_RATIO", "0.5"), 0.5),
    clickYMode: env("QLINK_CLICK_Y_MODE", "bottom-offset"),
    clickBottomOffsetPx: parsePositiveInteger(env("QLINK_CLICK_BOTTOM_OFFSET_PX", "105"), 105),
    clickYRatio: parseRatio(env("QLINK_CLICK_Y_RATIO", "0.925"), 0.925),
    restoreClipboard: parseBoolean(env("QLINK_RESTORE_CLIPBOARD", "1")),
    qdexEnabled: parseBoolean(env("QLINK_QDEX_ENABLED", "1")),
    qdexSendAudioToTelegram: parseBoolean(env("QLINK_QDEX_SEND_AUDIO_TO_TELEGRAM", "1")),
    qdexBridgeDir,
    qdexBroadcastPath: path.resolve(
      env("QLINK_QDEX_BROADCAST_PATH", path.join(qdexBridgeDir, "broadcast.jsonl"))
    ),
    qdexBroadcastPollMs: parsePositiveInteger(env("QLINK_QDEX_BROADCAST_POLL_MS", "500"), 500),
    qdexRelayTimeoutMs: parsePositiveInteger(env("QLINK_QDEX_RELAY_TIMEOUT_MS", "900000"), 900000),
    qdexAudioCaption: env("QLINK_QDEX_AUDIO_CAPTION", ""),
    dataDir
  };
}

function baseUrlForTelegram() {
  return `${TELEGRAM_API_BASE}/bot${config.telegramToken}`;
}

async function ensureSingleInstance() {
  const existing = await readTextFile(pidPath).catch(() => "");
  const pid = Number(existing.trim());
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`Q-Link semble deja lance (PID ${pid}).`);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Q-Link shutdown: ${reason}`);
  await fsp.unlink(pidPath).catch(() => {});
  process.exit(exitCode);
}

function loadEnvFile(filePath, { onlyMissing = false } = {}) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (!key || (onlyMissing && process.env[key] != null)) {
      continue;
    }
    process.env[key] = stripEnvQuotes(value);
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function env(name, defaultValue = "") {
  const value = process.env[name];
  return value == null || value === "" ? defaultValue : value;
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRatio(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function normalizeCommandPrefix(value) {
  const compact = String(value || "/qlink").trim();
  return compact.startsWith("/") ? compact : `/${compact}`;
}

function normalizeTelegramCommandToken(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ""));
}

function chunkText(text) {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(remaining.slice(0, TELEGRAM_MESSAGE_LIMIT));
    remaining = remaining.slice(TELEGRAM_MESSAGE_LIMIT);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}${os.EOL}`, "utf8");
}

async function readTextFile(filePath) {
  return fsp.readFile(filePath, "utf8");
}

async function writeTextFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, value, "utf8");
}

async function getFileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function formatError(error) {
  return error?.stack || error?.message || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
