# Third-Party Notices

Q-Link is a local bridge script. It does not vendor third-party packages in this repository.

Runtime integrations used by Q-Link:

- Node.js: runs `qlink.js`.
- Windows PowerShell / Windows Forms: provides tray icon, clipboard, window focus, and `SendKeys` automation.
- Telegram Bot API: receives Telegram text/voice messages and sends acknowledgements/audio.
- Codex Desktop: receives pasted prompts through local UI automation.
- QDex, optional: Q-Link can watch QDex's local `broadcast.jsonl` and relay generated audio to Telegram.
- ffmpeg, optional for voice input: converts Telegram audio before transcription.
- whisper.cpp `whisper-cli`, optional for voice input: performs local speech-to-text.

Q-Link expects optional ffmpeg/whisper binaries to be provided locally, commonly by the adjacent `AGENT_CODEX` setup. They are not bundled here.
