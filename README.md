# CodePulse Tracker

CodePulse Tracker is a lightweight, offline-first productivity analytics extension for VS Code. It quietly records coding activity in the local user data directory, summarizes time by project and language, and presents a clean dashboard in a native webview.

## Features

- Automatic tracking for eligible VS Code windows
- Support for `alwaysOpen` and `windowFocused` modes
- Grace-period handling for focus loss
- Shared heartbeat lease coordination to reduce duplicate counting across windows
- Local JSON persistence with export/reset controls
- Dashboard with recent sessions, totals, and project breakdowns

## Tracking modes

### alwaysOpen
Tracks whenever at least one eligible VS Code window is active. This mode does not require an active editor and keeps recording while the user is working in other apps.

### windowFocused
Tracks only while the VS Code window remains focused, with a configurable grace period before being treated as inactive.

## Commands

- `CodePulse: Open Dashboard`
- `CodePulse: Refresh Dashboard`
- `CodePulse: Export Data`
- `CodePulse: Reset Data`

## Local data

All analytics are stored locally in the VS Code global storage directory, which preserves privacy and keeps the extension portable and offline-friendly.

## Development

```bash
npm install
npm run compile
npm test
npm run package
```

The packaged VSIX is generated under the `artifacts/` directory.
