# QDex

QDex is a small standalone overlay that speaks **new visible Codex output**.

It does one job:

- auto-attach to the newest Codex rollout log under `~/.codex/sessions`
- keep scanning and automatically switch when a newer Codex session appears
- never read aloud history, tools, command output, context, or reasoning rows
- read only new visible `agent_message` output appended after attach
- show a compact observable activity label from Codex log rows such as tool calls, commands, patches, replies, and usage updates
- show the latest local 5h Codex usage/reset readout from `token_count` rows
- synthesize speech with Edge Neural TTS by default
- offer Windows Local TTS for fully offline non-AI speech
- keep Supertonic ONNX as an offline/local AI fallback
- stay out of the way as a transparent always-on-top overlay

It does not call an LLM to summarize or rewrite output, so reading does not spend extra Codex/OpenAI tokens. Edge Neural TTS uses Microsoft's online read-aloud service without an API key; switch to Windows Local for built-in offline non-AI speech, or Supertonic Local for offline local AI speech.

## Run

From this folder:

```powershell
npm install
npm start
```

Or double-click `launch-qdex.cmd` from the workspace root.

The app starts with reading enabled, auto-attaches to the newest active Codex session it can find, and keeps checking for a newer session every couple seconds.

## How It Connects To Codex

QDex does not need a Codex API key or a plugin install. It watches the local Codex session JSONL files written under:

```text
%USERPROFILE%\.codex\sessions
```

For another user, the normal setup is:

```powershell
npm install
npm start
```

or, for a double-clickable local build:

```powershell
npm install
npm run package:win
```

Then run:

```text
release\win-unpacked\QDex.exe
```

Codex must be running on the same Windows account. If their Codex logs live somewhere else, copy `.env.example` to `.env` and set `QDEX_CODEX_SESSIONS_ROOT` to that sessions folder.

The waveform only moves while audio is actually playing. `_` hides QDex to the Windows tray while it keeps listening. Use the settings icon to temporarily expand the overlay left/down and open the voice settings panel for TTS engine, Edge voice, Windows FR/EN auto mode or forced Windows voice, Supertonic local voice, speed, pitch, steps, volume, model download, and test voice.

The footer controls are icon-only: slower, play/pause, faster, skip current read, and read again. Speed changes affect the current playback immediately and also update the saved TTS speed for future output. The bottom-right status shows observable Codex activity such as tool calls, patches, replies, or a rotating idle line when there is no visible work.

The top bar has two gauges: the 5h usage/reset gauge, and a brain gauge estimating current context-window fullness from the latest `token_count.info.last_token_usage.total_tokens` divided by `model_context_window`. The context gauge shifts green to orange to red as it fills; the 5h usage gauge shifts toward red as remaining usage gets low.

The main status line is intentionally limited to observable activity from saved Codex events. It may say things like `Thinking`, `Running command`, `Editing files`, or `Drafting reply`, but it does not show hidden model chain-of-thought.

## Local Config

Optional machine-local overrides live in `.env`, which is ignored by Git. Start from `.env.example` if you want to change the session log root, scan interval, default voice, or overlay size:

```powershell
Copy-Item .env.example .env
```

## Assets

The packaged app intentionally does not ship the Supertonic ONNX model files or preset voice-style JSON files. This keeps releases smaller and avoids redistributing model weights by default.

Users who want Supertonic Local can download the model from QDex's settings UI after install. Edge Neural TTS and Windows Local TTS do not need these local assets.

For private/local development only, you can prefetch assets into the source folder:

```powershell
npm run fetch:assets
```

## Package

```powershell
npm install
npm run package:win
```

The double-clickable app is written to:

```text
release\win-unpacked\QDex.exe
```

The app is intentionally packaged as an unpacked local build. The older single-file portable wrapper was removed because it could leave stale extracted copies running from the Windows temp folder. Supertonic model assets are not included in the packaged app; users download them locally from QDex only if they enable that engine.

## Notes

- Old output is intentionally not read aloud when the app attaches.
- Markdown code blocks are reduced before speech so TTS does not spend minutes reading code punctuation.
- Edge TTS reads long replies in sentence-sized chunks so playback can begin before the whole answer is converted.
- Windows Local TTS uses installed Windows SAPI voices. In auto mode, QDex does a small local FR/EN text check and picks a matching installed Windows voice before synthesis; use forced voice mode if you want one fixed Windows voice.
- The UI keeps a short list of newly observed output so you can see what it read.

## Distribution Notes

QDex source is published under GPL-3.0-only. This is not legal advice, but do not publish the repo as if every part were plain MIT without checking the bundled pieces:

- `@andresaya/edge-tts` is GPL-3.0-only, so shipping it in the app has GPL implications for the distributed app.
- Electron, electron-builder, and onnxruntime-node are MIT-licensed dependencies.
- Supertonic sample/runtime code is MIT, but the Supertonic model weights are OpenRAIL-M and include use restrictions plus attribution expectations. QDex release builds do not include `assets/`; users can download model weights locally from the app.
- Windows Local TTS uses voices already installed on the user's PC; QDex does not redistribute Microsoft voices.
