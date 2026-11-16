# CodePulse Tracker

CodePulse Tracker is a private, offline-first coding activity tracker for Visual Studio Code. It records active time locally, attributes activity to the open workspace and editor language, and turns the history into daily, weekly, and monthly analytics.

## Features

- Coordinates a single tracking owner across VS Code windows sharing the same user data directory.
- Splits tracked time at local hour and day boundaries, uses elapsed monotonic time, and limits long timer gaps after sleep or event-loop stalls.
- Tracks workspace and language changes as they happen.
- Persists local sessions through serialized, atomic file replacement with a recoverable backup.
- Keeps saved daily totals across VS Code restarts and aggregates activity from all projects in the same profile.
- Shows project and language breakdowns, daily goal progress, current and longest streaks, peak coding hour, and an hourly activity chart.
- Exports session history as JSON or CSV from the dashboard or Command Palette.
- Keeps session data on the machine; no account or network service is required.

## Install and use

Install **CodePulse Tracker** from the Visual Studio Marketplace. Use the Command Palette (`Ctrl+Shift+P`) to run:

- **CodePulse: Open Dashboard**
- **CodePulse: Refresh Dashboard**
- **CodePulse: Export Data**, **CodePulse: Export JSON**, or **CodePulse: Export CSV**
- **CodePulse: Reset Data**

The status-bar item shows the current tracking state. Reset requires confirmation and starts a fresh tracking interval after clearing stored history.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `codepulse.enabled` | `true` | Enable automatic tracking. |
| `codepulse.trackingMode` | `alwaysOpen` | Track whenever a VS Code window is eligible (`alwaysOpen`) or only while the window is focused (`windowFocused`). |
| `codepulse.focusGracePeriod` | `30` | Seconds to continue tracking after focus is lost in `windowFocused` mode. |
| `codepulse.minSessionSeconds` | `10` | Minimum segment length to save when an interval ends or its attribution changes. |
| `codepulse.dailyGoalMinutes` | `120` | Daily goal shown by dashboard progress and goal analytics. |

Data is stored in the VS Code global storage directory. JSON and CSV exports are written only to a location selected by the user. The active/idle percentage is calculated over the observed span between sessions, so “idle / untracked” also includes time when VS Code was closed; it is not an operating-system idle detector.

## Build and test

Requires Node.js 22 or newer and npm.

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npx @vscode/vsce package
```

The test suite runs against the TypeScript time and persistence/analytics modules. VS Code-host integration and multi-process behavior still require manual testing in Windows 11 with multiple VS Code windows.

## Release

Marketplace publication is restricted to the `v<package-version>` tag or an explicitly selected `release` input in the GitHub Actions workflow. The workflow uses Visual Studio Marketplace Trusted Publishing (GitHub OIDC); it does not use a PAT secret. See [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) for the publisher-side configuration and release steps.

## Repository description suggestion

> Offline-first VS Code coding-time analytics with project and language breakdowns, goals, streaks, hourly insights, and private local exports.
