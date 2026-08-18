---
name: manual-test
description: Generate a focused manual Obsidian test pass for Scope Tabs
agent: plan
argument-hint: Name the feature or regression to test
---

Create a manual test pass for Scope Tabs focused on: ${input:focus:the current changes}

Use [AGENTS.md](../../AGENTS.md) and [README.md](../../README.md) as the behavior contract.

Cover a single-folder inert vault; three-book same/cross-book links; existing destination group reuse; right/left/up/down/spiral book creation; external book windows; manually opened free pop-out; right/left tab insertion and focus toggle; close/pop-out/minimize controls; manual/frontmatter colors; missing config manager and “never notify me”; duplicate-frontmatter prevention; active/inactive tab coloring; active-book-only explorer coloring; plugin disable/re-enable teardown.

For each test give setup, action, expected result, and diagnostics to capture on failure.
