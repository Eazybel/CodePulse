# Changelog

## 1.1.0 - 2026-11-16

- Hardened cross-window tracking ownership and serialized shared-state writes.
- Added monotonic elapsed-time accounting, sleep-gap limits, local-hour/day splitting, editor-language attribution, and workspace-specific project attribution.
- Added validated session loading, atomic persistence with backup recovery, export formats, and safe reset while tracking.
- Added daily, weekly, and monthly analytics, project/language breakdowns, daily goals, streaks, peak hours, and hourly activity.
- Reworked the dashboard to synchronize state over Webview messages with a nonce-based Content Security Policy.
- Added CI validation, VSIX packaging, and Marketplace Trusted Publishing through GitHub Actions OIDC.
