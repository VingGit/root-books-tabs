---
name: navigation-change
description: Safely change Root Books Tabs book-routing behavior
agent: agent
argument-hint: Describe the navigation behavior to add or change
---

Implement the requested Root Books Tabs navigation change: ${input:change:Describe the navigation change}

Read [AGENTS.md](../../AGENTS.md), [navigation.ts](../../src/navigation.ts), [scope.ts](../../src/scope.ts), and [types.ts](../../src/types.ts) before editing.

Use `C:\Users\Admin\quartz-vaults\test-vault` as the default disposable playground.

Constraints: preserve first-level-folder scope unless explicitly changing scope semantics; route every file-backed view; reuse existing destination tabs and Obsidian's forced empty leaf; open a fallback book file when the configured index is absent; keep the dropdown-selected book first in logical order and append new/returning groups at the configured expansion end; keep Spiral's base fixed at 2x2 and Grid dimensions within 2–16; prefer public Obsidian workspace APIs; respect explicit free destination leaves/windows and preserve free ownership when homogeneous duplicates are transferred or dragged; whole-group drag transfer and explicit tab regrouping must preserve every view state and active tab; detect pop-outs across window realms; preserve the re-entry guard and saved original `WorkspaceLeaf.openFile`; restore monkey patches on unload; keep one canonical managed tab group per book; return native-closed managed pop-outs without resurrecting intentional closes; feature-detect compatibility/internal operations; run `npm run build` and `npm run lint`.
