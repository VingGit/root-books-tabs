---
name: Repository boundaries
description: Human/agent documentation, source, privacy, and release boundaries
applyTo: "**"
---

# Repository boundaries

- Root Books Workspace is an Obsidian community plugin. Source lives in `src/`.
- Keep `src/main.ts` limited to lifecycle and orchestration.
- Keep human documentation in `README.md` and `CHANGELOG.md`. Agent-only
  material belongs in `AGENTS.md` or `.github/`.
- Use npm and keep `package-lock.json` reproducible.
- Do not commit `main.js`; attach `main.js`, `manifest.json`, and `styles.css`
  to releases.
- Operate locally and offline. Do not add telemetry, remote code, dependency
  installation, or filesystem access outside the vault.
- Never silently change companion-plugin settings. The user-facing onboarding
  flow must explain each recommendation and require an explicit action.
- Preserve unrelated vault frontmatter and note bodies. All migrations must be
  idempotent.
- Inspect status, diff, ignored files, secrets, author identity, branch, and
  remote before every commit and push.
