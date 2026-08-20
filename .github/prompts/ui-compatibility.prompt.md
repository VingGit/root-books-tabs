---
name: ui-compatibility
description: Repair tab, explorer, label, or book-control UI after an Obsidian change
agent: agent
argument-hint: Describe the broken visual behavior or Obsidian version
---

Repair this Root Books Tabs UI compatibility problem: ${input:problem:What broke?}

Read [AGENTS.md](../../AGENTS.md), [decorations.ts](../../src/decorations.ts), [styles.css](../../styles.css), and [navigation.ts](../../src/navigation.ts).

Use `C:\Users\Admin\quartz-vaults\test-vault` as the default disposable playground.

Do not change scope semantics unless routing is actually wrong. Keep Obsidian DOM selectors inside decoration/CSS code. Feature-detect DOM/internal structures and detect pop-outs across window realms. Preserve `--scope-tabs-book-color`, `--scope-tabs-tab-text-color`, and `data-scope-tabs-book`. Verify resource tabs, pure Background styling and configured foreground application across every tab style, selected-first explorer ordering and latest-secondary promotion, wrapping secondary close/open-another hover states, Shift-hover duplicate-instance selection with target dimming plus Ctrl-click close-all, visible main/pop-out/free-homogeneous pseudo-tab book menus with whole-pop-out pin/return and menu/long-press tab sorting actions, pseudo-tab whole-group dragging with edge markers across main/pop-out documents, Grid overflow controls remaining left of the stable main selector, ownership-preserving transfers/native-close return, complete cleanup, reduced-motion behavior, and default dark/light themes.
