<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" alt="QDex logo">
</p>

# QDex

QDex is a compact Windows overlay that reads new visible Codex responses aloud.

It watches local Codex session logs, follows the active session, and speaks only newly appended assistant messages. It does not call a language model, summarize text, or send Codex output to an API.

## Features

- Tracks the newest Codex session under `%USERPROFILE%\.codex\sessions`
- Reads only new visible assistant output after QDex attaches
- Skips command output, tool logs, history, context rows, and reasoning rows
- Shows observable activity such as tool calls, commands, patches, replies, and usage updates
- Displays local usage/reset status from Codex `token_count` events
- Supports Edge Neural TTS and Windows Local TTS
- Runs as a compact transparent always-on-top Tauri overlay

## Requirements

- Windows 10 or later
- Node.js 22 or later
- Rust stable toolchain
- A local Codex installation that writes session logs under the current Windows account

## Run

```powershell
npm install
npm run dev
```

QDex starts with speech enabled and automatically attaches to the newest available Codex session.

## Configuration

Machine-local settings can be provided through `.env`. The file is ignored by Git.

```powershell
Copy-Item .env.example .env
```

If Codex logs are stored outside the default location, set:

```text
QDEX_CODEX_SESSIONS_ROOT=C:\path\to\sessions
```

## TTS Engines

QDex supports two speech engines:

- Edge Neural TTS for online neural voices without an API key
- Windows Local TTS for built-in offline SAPI voices

## Build

```powershell
npm install
npm run build
```

The release executable is written to:

```text
src-tauri\target\release\qdex.exe
```

The Windows installer is written to:

```text
src-tauri\target\release\bundle\nsis\QDex_0.1.0_x64-setup.exe
```

Build output is ignored by Git.

## Notes

- Previous Codex output is not read when QDex attaches to a session.
- Markdown code blocks are reduced before speech to avoid reading long blocks of punctuation.
- Edge Neural TTS uses Microsoft Edge Read Aloud endpoints and does not require an API key.
- The status line is limited to observable saved events and does not expose hidden model reasoning.

## License

QDex is licensed under GPL-3.0-only. See [LICENSE](LICENSE).
