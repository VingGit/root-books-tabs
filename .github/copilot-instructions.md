Scope Tabs is an Obsidian desktop plugin that treats each first-level vault folder as a separate “book”. Keep scope resolution, navigation routing, color metadata, DOM decoration, and settings as separate modules.

Prefer documented Obsidian APIs. Any DOM selector or internal tab-group operation must be feature-detected, isolated, and allowed to fail without breaking core navigation.

Do not add network access, telemetry, remote code, or filesystem access outside the vault. Existing Markdown files may only be mutated through the explicit per-book frontmatter color feature.

The current scope depth is intentionally fixed at one first-level folder. Design new code so another scope resolver can be introduced later without rewriting navigation.

Always preserve graceful unload: patched methods must be restored and plugin-owned DOM/style state removed.

See `AGENTS.md` for the full product contract and `.github/prompts/` for task-specific workflows.
