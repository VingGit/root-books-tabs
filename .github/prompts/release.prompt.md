---
name: release
description: Prepare and verify a Scope Tabs Obsidian release
agent: agent
argument-hint: Enter the release version, for example 0.1.1
---

Prepare Scope Tabs release `${input:version:0.1.1}`.

Read [AGENTS.md](../../AGENTS.md), [manifest.json](../../manifest.json), [versions.json](../../versions.json), [package.json](../../package.json), and [release workflow](../workflows/release.yml).

Confirm semantic version `x.y.z`; synchronize manifest/package/versions; keep plugin ID `scope-tabs`; verify `minAppVersion`; run `npm ci`, `npm run build`, and `npm run lint`; confirm `main.js`, `manifest.json`, and `styles.css`; summarize user-visible release notes; use a tag exactly equal to the version with no leading `v`; do not commit generated `main.js`.
