---
name: frontmatter-colors
description: Change Root Books Tabs per-book color configuration safely
agent: agent
argument-hint: Describe the color/config-file change
---

Implement this book-color/config change: ${input:change:Describe the color behavior}

Read [AGENTS.md](../../AGENTS.md), [colors.ts](../../src/colors.ts), [settings.ts](../../src/settings.ts), and [settings-model.ts](../../src/settings-model.ts).

Preserve these invariants: automatic local colors with optional frontmatter overrides; fallback colors survive settings reset; default config note `index.md`, color `#RRGGBB`, and Background-only `tab-text-bg` accepting black/white/CSS hex with white fallback. Automatic colors never populate new config notes. Existing notes and unrelated properties are preserved through processFrontMatter. Dedicated `book-tabs:` section values win; migrate owned legacy `book-tabs-` aliases and comment-owned plain fields without disturbing unrelated properties. New settings and color overrides are written only inside that section with stable key order. New-book, fresh-clone and ordering actions may generate missing configs. Config filenames reject destination collisions; color-key migrations preserve colliding user keys and use dedicated section fields. Missing-note notifications remain suppressible. No network calls. Use portable-book-config.prompt.md for the full acceptance pass.
