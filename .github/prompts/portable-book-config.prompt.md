# Validate portable book configuration and ordering

Read root AGENTS.md and README.md first. Keep work local unless release is explicitly requested.

1. Use a disposable vault with multiple first-level books and an unscoped root note. Preserve arbitrary existing frontmatter and note bodies.
2. Exercise one-time root `index.md` startup with a file, book folder, invalid path, saved workspace, empty book, and reset Boolean.
3. Enter book ordering; verify recursive `fileOrder` generation for Markdown and non-Markdown children, stale/new-name reconciliation, config-note exclusion plus global top/bottom pinning, Markdown creation timestamps, YAML help preservation, three-value cycling and direction controls, highlight ending above the launcher with breathing room, inert dimmed UI, red-X and dimmed-area exits, temporary dragged-folder collapse, depth-aligned before/after targets, restored folder states, ordinary same-name swaps, cross-book rejection, inheritance, exit and unload cleanup.
4. Verify exact anchored ignore paths, escaped special names, removal without losing other rules, empty/fully hidden books and session-only reveal.
5. Verify automatic colors/overrides, `book-tabs-` aliases and plain-key collision preservation, reset preservation, config renames with collision and rollback checks, and all frontmatter commands in main/pop-out views.
6. Check right-of-current/end tabs and row-major Grid, then overflow through all configured base cells. Long-press regrouping and increased row/column settings must refill that Grid and return managed pop-outs while preserving explicit free-window ownership.
7. Verify index-move blocking and each transfer strategy, the checked excluded-folder count action plus native sliding tree reveal, inherited folder templates for Markdown and non-Markdown files, automatic link updating, and duplicate-tab removal during regrouping.
8. Run npm ci, npm test, npm run build, npm run lint. Test single-folder inert routing. Record actual evidence and unresolved checks; do not infer live success from compilation.
