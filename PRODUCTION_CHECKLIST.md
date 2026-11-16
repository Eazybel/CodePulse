# CodePulse Tracker 1.1.0 Production Checklist

## Release metadata

- [x] Package name and publisher remain `codepulse-tracker`.
- [x] Package version is `1.1.0`; extension engine remains VS Code `^1.88.0`.
- [x] Release workflow uses `@vscode/vsce publish --oidc`; it contains no PAT fallback.
- [ ] Create the Marketplace Trusted Publishing policy for repository owner `Eazybel`, repository `CodePulse`, workflow `publish.yml`, and no GitHub environment.
- [ ] Confirm the policy is enabled on the `codepulse-tracker` Marketplace publisher.
- [ ] Review the GitHub repository description suggestion in `README.md`.

## Required local verification

Update this table with the actual results from the release checkout. Do not mark unexecuted checks as passing.

| Check | Result |
| --- | --- |
| `npm ci` | PASS — clean install; 208 packages added; 0 vulnerabilities. npm reported a deprecated transitive Secretlint preset. |
| `npm run compile` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — no warnings |
| `npm test` | PASS — 14 tests, 0 failures |
| `npx @vscode/vsce package` | PASS — `codepulse-tracker-1.1.0.vsix`, 25,711 bytes |
| VSIX contents inspected | PASS — 12 entries; required runtime files, README, changelog, license, and icon present; no source, tests, maps, lockfile, or dependencies. |
| VSIX warnings and dependency audit | PASS — no VSIX warnings; `npm audit` found 0 vulnerabilities. Clean install emitted the transitive deprecation warning noted above. |
| Windows 11 extension activation | NOT TESTED — no isolated extension-host test run. |
| Dashboard rendering, timeframe switching, and exports | NOT TESTED end-to-end in a VS Code Webview. |
| Reset while tracking and restart recovery | PASS for datastore reset/recovery unit tests; VS Code lifecycle integration NOT TESTED. |
| Multiple live VS Code windows | PASS for concurrent datastore-instance tests; real VS Code window handoff NOT TESTED. |
| Timezone and daylight-saving boundaries | PASS for automated local-range and DST tests; live timezone change and sleep/resume on Windows NOT TESTED. |

## Manual Windows 11 release validation

- [ ] Install the packaged VSIX in a clean VS Code profile and verify activation and status-bar behavior.
- [ ] Verify daily, weekly, and monthly dashboard state, project/language breakdowns, goal progress, streaks, and hourly chart.
- [ ] Export JSON and CSV from both the dashboard and Command Palette; check CSV quoting and the selected destination.
- [ ] Reset while tracking, confirm the dashboard clears, and confirm only post-reset activity returns.
- [ ] Close/reopen VS Code and confirm saved sessions recover from the primary JSON file or its backup.
- [ ] Open two VS Code windows using the same profile; verify one owner records time and ownership transfers after the owner exits.
- [ ] Check midnight, daylight-saving, timezone-change, and resume-from-sleep behavior on the target Windows 11 system.
- [ ] Confirm no data is sent over the network and generated package contains no source maps, tests, or development-only files.

## Release commands

After all required checks pass and the Trusted Publishing policy is configured:

```powershell
npm ci
npm run compile
npm run typecheck
npm run lint
npm test
npx @vscode/vsce package
git tag v1.1.0
git push origin v1.1.0
```

The tag publishes only when its version exactly matches `package.json`. Alternatively, select **Run workflow** in GitHub Actions and set the `release` input to `true`. Never store or add a Marketplace PAT as a fallback.
