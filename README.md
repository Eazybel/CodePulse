# CodePulse Tracker

CodePulse Tracker is an offline-first Visual Studio Code extension for understanding your development activity. It stores activity locally in VS Code's global extension storage and does not send telemetry or make network requests at runtime.

## Features
- Automatic tracking with `alwaysOpen` and `windowFocused` modes.
- Local project and language attribution (no source code or file contents are collected).
- Daily goal, streak, hourly activity, project and language summaries.
- 30-day activity view, contribution heatmap and recent sessions.
- JSON and CSV export; explicit confirmation before statistics reset.
- Local JSON persistence with serialized writes, temporary-file replacement and backup recovery.
- Shared heartbeat lease to coordinate multiple VS Code windows.

## Installation
Install the packaged `codepulse-tracker-1.0.0.vsix` from VS Code using **Extensions: Install from VSIX...**. The extension runs locally and does not require a separate service.

## Configuration
| Setting | Default | Description |
|---|---:|---|
| `codepulse.trackingMode` | `alwaysOpen` | `alwaysOpen` or `windowFocused`. |
| `codepulse.focusGracePeriodSeconds` | 30 | Grace period after losing focus. |
| `codepulse.dailyGoalMinutes` | 240 | Daily activity goal. |
| `codepulse.breakReminderMinutes` | 90 | Tracked-time reminder interval; 0 disables. |

## Dashboard
Run **CodePulse: Open Dashboard** or click the status bar. Daily, weekly and monthly navigation is available, with activity, hourly distribution, project/language breakdowns and recent sessions. The heatmap represents the latest 30 days in this initial release.

## Tracking modes
- **alwaysOpen** counts elapsed time while the extension host is running, including periods when another application is in front. Long timer gaps over five minutes are discarded as a sleep/recovery safeguard.
- **windowFocused** counts while the VS Code window is focused and for the configured grace period after focus is lost.

## Analytics definitions
Durations are milliseconds. Calendar dates and hours are derived from the machine's local timezone. Productive-day average is the mean across days with recorded activity. A streak counts consecutive days with any recorded activity, starting today or yesterday if today has no activity. Goal progress is capped at 100%.

## Export
Use **CodePulse: Export Data** and choose JSON or CSV in the save dialog. JSON includes the schema version and export timestamp. CSV contains session-level rows.

## Storage and migration
Data is stored under `context.globalStorageUri` in `codepulse-data.json`, with a backup file and temporary write file. Writes are serialized and use rename-based replacement. The schema is versioned. Unsupported future schemas are not loaded as current data. The first release uses schema version 1.

## Multi-window coordination
Windows coordinate through a shared `heartbeat.json` lease and a short-lived lock directory. A lease expires if its owner stops renewing it. Coordination depends on VS Code windows sharing the same global storage filesystem; separate remote authorities or profiles may have separate stores.

## Privacy
Activity metadata is stored locally. CodePulse does not collect source code, file contents, or file paths and makes no runtime network requests. Project names and language identifiers are stored in the local database.

## Development
Requires Node.js and npm.
```bash
npm install
npm test
npm run package
```
The package command uses `@vscode/vsce`. The repository CI workflow installs dependencies, runs tests, packages the VSIX and uploads the VSIX and source archive as build artifacts.

## Troubleshooting
- If the status bar does not appear, run **Developer: Reload Window**.
- If tracking is paused, run **CodePulse: Resume Tracking**.
- If storage is inaccessible, check VS Code extension storage permissions.
- If the lease file is stale after a crash, it expires automatically.

## Screenshots
Screenshots will be added after a verified extension-host run. No screenshots are included in this source release.

## Known limitations
- Application focus detection is limited to VS Code window focus events.
- Sleep detection uses a conservative five-minute timer-gap cutoff; platform-specific sleep events are not available through the VS Code API.
- The current heatmap shows the latest 30 days; yearly 365-day history is planned for a subsequent release.
- Cross-window deduplication is reliable only where extension windows share the same storage location and filesystem semantics.

## Version
1.0.0 — initial release.
