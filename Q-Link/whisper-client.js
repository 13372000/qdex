import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_CODEX_DIR = path.resolve(__dirname, "..", "AGENT_CODEX");

const DEFAULT_WHISPER_CLI = path.join(AGENT_CODEX_DIR, "whisper", "Release", "whisper-cli.exe");
const DEFAULT_WHISPER_MODEL = path.join(AGENT_CODEX_DIR, "whisper", "models", "ggml-base.bin");
const DEFAULT_FFMPEG_PATH = path.join(AGENT_CODEX_DIR, "tools", "ffmpeg", "bin", "ffmpeg.exe");

export async function transcribeAudioBuffer(audioBuffer, options = {}) {
  const id = randomUUID();
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `qlink-whisper-in-${id}.ogg`);
  const wavPath = path.join(tmpDir, `qlink-whisper-wav-${id}.wav`);
  const timings = {};

  try {
    const writeStartedAt = Date.now();
    await fs.writeFile(inputPath, audioBuffer);
    timings.writeMs = Date.now() - writeStartedAt;

    const convertStartedAt = Date.now();
    await convertToWav(inputPath, wavPath);
    timings.convertMs = Date.now() - convertStartedAt;

    const whisperStartedAt = Date.now();
    const text = await runWhisper(wavPath);
    timings.whisperMs = Date.now() - whisperStartedAt;
    return text;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(wavPath).catch(() => {});
    if (typeof options.onTiming === "function") {
      try {
        options.onTiming({
          ...timings,
          totalMs: Object.values(timings).reduce((sum, value) => sum + value, 0)
        });
      } catch {
        // Timing hooks are diagnostic only; transcription result/error wins.
      }
    }
  }
}

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = process.env.FFMPEG_PATH?.trim() || DEFAULT_FFMPEG_PATH;
    const child = spawn(ffmpeg, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputPath
    ]);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`ffmpeg introuvable: ${error.message}. Verifie FFMPEG_PATH dans .env`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg echec (code ${code}): ${stderr.slice(-200)}`));
      }
    });
  });
}

function runWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    const cli = process.env.WHISPER_PATH?.trim() || DEFAULT_WHISPER_CLI;
    const model = process.env.WHISPER_MODEL?.trim() || DEFAULT_WHISPER_MODEL;
    const outBase = wavPath;
    const language = normalizeWhisperLanguage(process.env.WHISPER_LANGUAGE);
    const args = [
      "-m",
      model,
      "-f",
      wavPath,
      "-l",
      language,
      "--no-timestamps",
      "-otxt",
      "-of",
      outBase,
      "-np"
    ];

    appendPositiveIntegerArg(args, "-t", process.env.WHISPER_THREADS);
    appendPositiveIntegerArg(args, "-bs", process.env.WHISPER_BEAM_SIZE);
    appendPositiveIntegerArg(args, "-bo", process.env.WHISPER_BEST_OF);

    if (normalizeBooleanEnv(process.env.WHISPER_NO_FALLBACK, false)) {
      args.push("-nf");
    }

    const child = spawn(cli, args);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`whisper-cli introuvable: ${error.message}`));
    });
    child.on("close", async (code) => {
      if (code !== 0) {
        return reject(new Error(`whisper-cli echec (code ${code}): ${stderr.slice(-200)}`));
      }
      const txtPath = `${outBase}.txt`;
      try {
        const raw = await fs.readFile(txtPath, "utf8");
        await fs.unlink(txtPath).catch(() => {});
        resolve(raw.trim());
      } catch {
        reject(new Error("whisper-cli n'a pas produit de fichier .txt"));
      }
    });
  });
}

function appendPositiveIntegerArg(args, flag, value) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    args.push(flag, String(parsed));
  }
}

function normalizeWhisperLanguage(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(normalized) || normalized === "auto" ? normalized : "auto";
}

function normalizeBooleanEnv(value, defaultValue = false) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}
