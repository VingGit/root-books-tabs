---
name: ui-compatibility
description: Repair tab, explorer, label, or book-control UI after an Obsidian change
agent: agent
argument-hint: Describe the broken visual behavior or Obsidian version
---

Repair this Scope Tabs UI compatibility problem: ${input:problem:What broke?}

Read [AGENTS.md](../../AGENTS.md), [decorations.ts](../../src/decorations.ts), [styles.css](../../styles.css), and [navigation.ts](../../src/navigation.ts).

Do not change scope semantics unless routing is actually wrong. Keep Obsidian DOM selectors inside decoration/CSS code. Feature-detect DOM/internal structures. Preserve `--scope-tabs-book-color` and `data-scope-tabs-book`. Verify active/inactive tab brightness, all built-in tab styles, explorer styles, minimized groups, pop-outs, and default dark/light themes.
