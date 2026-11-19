# Changelog

## 1.1.4

- Custom date range: pick a start and end date on the dashboard (or export) for any period.
- Activity heatmap: a 12-week grid showing coding time per day.
- Idle detection: time stops counting after no typing or cursor movement for a set time (new setting `codepulse.idleTimeoutMinutes`, default 5, 0 turns it off).
- Recent sessions show the latest 5 with a "See more" button for the rest.

## 1.1.3

- Same weekly and monthly per-day analytics as 1.1.2, released under a new version because 1.1.2 already existed on the Marketplace.

## 1.1.2

- Weekly mode now shows a per-day bar chart labelled Mon–Sun, with the most active day summarized under it.
- Monthly mode now shows a per-day bar chart for every day of the month instead of repeating the 24-hour view.
- Daily mode keeps the hourly activity view.

## 1.1.0 - 2026-11-16

- Hardened cross-window tracking ownership and serialized shared-state writes.
- Added monotonic elapsed-time accounting, sleep-gap limits, local-hour/day splitting, editor-language attribution, and workspace-specific project attribution.
- Added validated session loading, atomic persistence with backup recovery, export formats, and safe reset while tracking.
- Added daily, weekly, and monthly analytics, project/language breakdowns, daily goals, streaks, peak hours, and hourly activity.
- Reworked the dashboard to synchronize state over Webview messages with a nonce-based Content Security Policy.
- Added CI validation, VSIX packaging, and Marketplace Trusted Publishing through GitHub Actions OIDC.
