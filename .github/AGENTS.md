# GitHub/repository automation instructions

Files below `.github/` support CI, releases, and reusable development prompts. Product behavior belongs in root `AGENTS.md` and `src/`.

- Keep CI reproducible with `npm ci`.
- The release tag must exactly equal `manifest.json.version` and must not use a leading `v`.
- Obsidian release assets are `main.js`, `manifest.json`, and `styles.css`.
- Prompt files belong in `.github/prompts/*.prompt.md` and should each describe one reusable task.
- Repository-wide Copilot instructions must stay concise; task detail belongs in prompt files.
- Do not put secrets, vault data, tokens, or generated release binaries in prompt/instruction files.
