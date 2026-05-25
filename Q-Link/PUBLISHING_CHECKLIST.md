# Publishing Checklist

Before pushing Q-Link to GitHub:

- Confirm `.env`, `data/`, `logs/`, and `node_modules/` are not staged.
- Confirm `TELEGRAM_BOT_TOKEN` and chat ids are absent from tracked files.
- Run `npm run check`.
- Run a PowerShell syntax check for `scripts/*.ps1`.
- Decide the repository license before public release.
