<p align="center">
  <img src="build/icon.png" width="96" alt="QDex logo">
</p>

# QDex

QDex is a lightweight Windows overlay that reads new visible Codex responses aloud.

The app watches local Codex session logs, follows the active session, and speaks only newly appended assistant messages. It does not call a language model, summarize text, or send Codex output to an API.

## Features

- Tracks the newest Codex session under `%USERPROFILE%\.codex\sessions`
- Reads only new visible assistant output after QDex attaches
- Skips command output, tool logs, history, context rows, and reasoning rows
- Shows observable activity such as tool calls, commands, patches, replies, and usage updates
- Displays local 5-hour usage/reset status from Codex `token_count` events
- Provides Edge Neural TTS, Windows Local TTS, and optional Supertonic Local TTS
- Runs as a compact transparent always-on-top overlay with tray support

## Requirements

- Windows 10 or later
- Node.js 22 or later
- A local Codex installation that writes session logs under the current Windows account

## Installation

```powershell
npm install
npm start
```

QDex starts with speech enabled and automatically attaches to the newest available Codex session.

## Configuration

Machine-local settings can be provided through `.env`. The file is ignored by Git.

```powershell
Copy-Item .env.example .env
```

Available settings include the Codex sessions folder, scan interval, overlay size, default TTS engine, Edge voice, and Windows voice mode.

If Codex logs are stored outside the default location, set:

```text
QDEX_CODEX_SESSIONS_ROOT=C:\path\to\sessions
```

## TTS Engines

QDex supports three speech engines:

- Edge Neural TTS for online neural voices without an API key
- Windows Local TTS for built-in offline SAPI voices
- Supertonic Local TTS for optional offline ONNX-based speech

Supertonic assets are not bundled with the repository or release build. They can be downloaded from the QDex settings UI when the Supertonic engine is enabled.

## Build

```powershell
npm install
npm run package:win
```

The unpacked Windows build is written to:

```text
release\win-unpacked\QDex.exe
```

Release output is ignored by Git.

## Notes

- Previous Codex output is not read when QDex attaches to a session.
- Markdown code blocks are reduced before speech to avoid reading long blocks of punctuation.
- Edge Neural TTS streams long replies in sentence-sized chunks so playback can begin sooner.
- The status line is limited to observable saved events and does not expose hidden model reasoning.

## License

QDex is licensed under GPL-3.0-only. See [LICENSE](LICENSE).

Dependency and optional asset licenses are tracked separately by their upstream projects:

- `@andresaya/edge-tts`: GPL-3.0-only
- Electron, electron-builder, and onnxruntime-node: MIT
- Supertonic model assets: OpenRAIL-M
- Windows Local TTS voices: provided by the host Windows installation
