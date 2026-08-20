---
name: frontmatter-colors
description: Change Root Books Tabs per-book color configuration safely
agent: agent
argument-hint: Describe the color/config-file change
---

Implement this book-color/config change: ${input:change:Describe the color behavior}

Read [AGENTS.md](../../AGENTS.md), [colors.ts](../../src/colors.ts), [settings.ts](../../src/settings.ts), and [settings-model.ts](../../src/settings-model.ts).

Preserve these invariants unless explicitly changed: manual/frontmatter modes are mutually exclusive; default config note is `index.md`; default background key is `color` with `#RRGGBB`; default tab-text key is `tab-text-bg`, accepting `black`, `white`, or any valid CSS hex color and falling back to white; automatic manual black/white foreground selection uses WCAG relative-luminance contrast and recalculates on background changes without displaying a recommendation; text foreground applies to every tab color style; existing config files are never overwritten; existing files use `FileManager.processFrontMatter`; never duplicate a property; missing files are created only through explicit user action; missing-file notifications can be permanently disabled; no network requests.
