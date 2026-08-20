---
name: manual-test
description: Generate a focused manual Obsidian test pass for Root Books Tabs
agent: plan
argument-hint: Name the feature or regression to test
---

Create a manual test pass for Root Books Tabs focused on: ${input:focus:the current changes}

Use [AGENTS.md](../../AGENTS.md) and [README.md](../../README.md) as the behavior contract.

Use `C:\Users\Admin\quartz-vaults\test-vault` as the default disposable playground.

Cover a single-folder inert vault; same/cross-book links and existing destination-tab reuse; root-level files; sole-file and empty-leaf replacement; right/left/up/down creation; Grid row/column slider and number-input boundaries/defaults, multiple rectangle shapes, full-capacity overflow cycling in every direction, and a visible tab bar on every overflow tile; a stable rightmost new-book-position selector with Grid overflow controls to its left; selected book always first and additions appended in logical order; managed main/pop-out recovery; visible cross-realm pop-out book menu with whole-book pin and Return book to Obsidian; pseudo-tab whole-group dragging across each main-workspace edge, out to a pop-out, and back into main while preserving every tab, active state, and managed/free ownership; menu and long-press sorting of mixed/separated tabs into books with active-focus preservation, reduced-motion behavior, and no unscoped-tab movement; explicit free destinations and homogeneous duplicate groups whose move/return preserves free ownership; click-to-close-latest, Ctrl-click close-all, and Shift-click instance/tab picker with exact-target red dimming, no leaf focus change, and temporary obscured-pop-out preview/restoration; missing-index entry fallback; note and toolbar-folder creation in current-folder/book-root modes, including the selected-book fallback with no open file; native-close return and intentional close; PNG, SVG, PDF, Canvas, Base, and deferred views; white manual tab-text defaults and manual controls absent from book-color rows; compact Background-only manual black/white controls and frontmatter `tab-text-bg` values in black/white/custom hex plus missing/invalid white repair; normal Obsidian text in Underline, Colored dot, and Custom styles; missing config manager and duplicate prevention; primary-close promotion of the latest secondary, close-on-hover secondary bars, unopened-book-only launcher with wrapping narrow hover text and Shift-click pop-out, and complete explorer cleanup; narrow/fullscreen CSS modal Apply/Cancel; plugin disable/re-enable teardown.

For each test give setup, action, expected result, and diagnostics to capture on failure.
