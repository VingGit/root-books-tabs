---
name: frontmatter-colors
description: Change Scope Tabs per-book color configuration safely
agent: agent
argument-hint: Describe the color/config-file change
---

Implement this book-color/config change: ${input:change:Describe the color behavior}

Read [AGENTS.md](../../AGENTS.md), [colors.ts](../../src/colors.ts), [settings.ts](../../src/settings.ts), and [settings-model.ts](../../src/settings-model.ts).

Preserve these invariants unless explicitly changed: manual/frontmatter modes are mutually exclusive; default config note is `index.md`; default key is `color`; valid values are `#RRGGBB`; existing config files are never overwritten; existing files use `FileManager.processFrontMatter`; never duplicate the property; missing files are created only through explicit user action; missing-file notifications can be permanently disabled; no network requests.
