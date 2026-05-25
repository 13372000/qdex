<p align="center">
  <img src="assets/qlink.svg" width="120" alt="Q-Link logo">
</p>

# Q-Link

Q-Link is a small standalone bridge:

```text
Telegram -> local transcription if needed -> Codex Desktop clipboard paste
```

It is intentionally different from QAgent. QAgent talks to `codex app-server`; Q-Link tries to inject into the visible Codex Desktop app by focusing the window, pasting the prompt, and pressing Enter.

## Start

```powershell
cd C:\Users\vcplo\Documents\AGENT\Q-Link
.\qlink-tray.bat start
```

Q-Link reads:

1. `Q-Link/.env`
2. `../AGENT_CODEX/.env` for missing variables

If `AGENT_CODEX/.env` already contains `TELEGRAM_BOT_TOKEN`, Q-Link can reuse the same bot.

Important: do not run QAgent and Q-Link with the same Telegram bot at the same time. Telegram long polling will send updates to only one of them.

## Tray App

`qlink-tray.bat start` launches Q-Link as a small Windows tray app. It starts hidden by default and appears in the Windows hidden icons area.

The tray menu provides:

- Start Q-Link
- Restart Q-Link
- Stop Q-Link
- Open Logs
- Open README
- Exit

The service runner is still available directly:

```powershell
.\qlink.bat start
.\qlink.bat status
.\qlink.bat stop
.\qlink.bat restart
```

## Commands

- Free text: paste the message into Codex Desktop.
- Voice message: transcribe locally with Whisper, then paste the text.
- `/qlink <prompt>`: explicit prompt command.
- `/status`: show bridge status.
- `/help`: show help.

## Desktop Injection

Q-Link uses the Windows clipboard and `SendKeys`:

1. Find a Codex Desktop window.
2. Bring it to the foreground.
3. Optionally click near the bottom prompt area.
4. Paste the prompt.
5. Press `Enter`.

The default target is a window with process name `Codex` and title matching `Codex`.

Useful settings:

```env
QLINK_TARGET_PROCESS_NAMES=Codex
QLINK_WINDOW_TITLE_PATTERN=Codex
QLINK_CLICK_INPUT=1
QLINK_CLICK_X_RATIO=0.5
QLINK_CLICK_Y_MODE=bottom-offset
QLINK_CLICK_BOTTOM_OFFSET_PX=105
QLINK_CLICK_Y_RATIO=0.925
QLINK_SUBMIT_KEYS={ENTER}
QLINK_AUTO_SUBMIT=1
```

`bottom-offset` is more stable when the Codex window is resized because it clicks a fixed number of pixels above the bottom of the window. `QLINK_CLICK_Y_RATIO` is kept as a fallback if `QLINK_CLICK_Y_MODE=ratio`.

If Codex Desktop needs another submit shortcut, set `QLINK_SUBMIT_KEYS`, for example `^{ENTER}` for Ctrl+Enter.
Set `QLINK_AUTO_SUBMIT=0` while calibrating the click position so Q-Link pastes without pressing Enter.

## QDex Audio

If QDex is running, Q-Link can relay the spoken answer back to Telegram.

The flow is:

```text
Telegram -> Q-Link -> Codex Desktop -> QDex reads Codex output -> QDex broadcast audio -> Q-Link sends audio to Telegram
```

Q-Link does not send text to QDex. It only watches QDex's normal local broadcast file:

```text
%USERPROFILE%\.qdex\broadcast.jsonl
```

When a prompt came from Telegram, Q-Link waits for the next QDex `codex-log` audio broadcast and sends that audio to the same Telegram chat.

Useful settings:

```env
QLINK_QDEX_ENABLED=1
QLINK_QDEX_SEND_AUDIO_TO_TELEGRAM=1
QLINK_QDEX_BROADCAST_POLL_MS=500
QLINK_QDEX_RELAY_TIMEOUT_MS=900000
```

## Voice

The transcription path is reused from `AGENT_CODEX`:

```text
Telegram audio -> ffmpeg -> whisper-cli.exe -> text -> Codex Desktop
```

Q-Link reads `WHISPER_PATH`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `WHISPER_THREADS`, `WHISPER_BEAM_SIZE`, `WHISPER_BEST_OF`, `WHISPER_NO_FALLBACK`, and `FFMPEG_PATH`.

## Limits

- Codex Desktop must be open and unlocked.
- This is UI automation, so focus matters.
- The clipboard is temporarily replaced with the prompt. Text clipboard content is restored by default.
- It does not call `codex app-server` and does not create or resume app-server threads.

## Publishing Notes

Do not publish local runtime files:

- `.env`
- `data/`
- `logs/`
- `node_modules/`

These are already ignored by `.gitignore`.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for external tool/runtime notes.
