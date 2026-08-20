---
name: release
description: Prepare and verify a Root Books Tabs Obsidian release
agent: agent
argument-hint: Enter the release version, for example 0.1.1
---

Prepare Root Books Tabs release `${input:version:0.1.1}`.

Read [AGENTS.md](../../AGENTS.md), [manifest.json](../../manifest.json), [versions.json](../../versions.json), [package.json](../../package.json), [package-lock.json](../../package-lock.json), and the automatic release job in the [build workflow](../workflows/lint.yml).

Checklist:

1. Confirm semantic version format `x.y.z`.
2. Keep version synchronized in `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`; run the normal npm version/update flow so lock metadata remains valid for `npm ci`.
3. Keep `manifest.json.id` exactly `scope-tabs`.
4. Confirm `minAppVersion` still covers all public Obsidian APIs used.
5. Run `npm ci`, `npm run build`, and `npm run lint`.
6. Confirm `main.js`, `manifest.json`, and `styles.css` exist for release.
7. Summarize user-visible changes for release notes.
8. Let the successful `main` build create a Git tag exactly equal to the version with no leading `v`.
9. Do not commit generated `main.js`; the automatic release job attaches it to a public GitHub release.
