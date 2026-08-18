---
name: navigation-change
description: Safely change Scope Tabs book-routing behavior
agent: agent
argument-hint: Describe the navigation behavior to add or change
---

Implement the requested Scope Tabs navigation change: ${input:change:Describe the navigation change}

Read [AGENTS.md](../../AGENTS.md), [navigation.ts](../../src/navigation.ts), [scope.ts](../../src/scope.ts), and [types.ts](../../src/types.ts) before editing.

Constraints: preserve first-level-folder scope unless explicitly changing scope semantics; prefer public Obsidian workspace APIs; respect explicit destination leaves/windows; preserve the re-entry guard and saved original `WorkspaceLeaf.openFile`; restore monkey patches on unload; keep one managed tab group per book by default; feature-detect compatibility/internal operations; run `npm run build` and `npm run lint`.
