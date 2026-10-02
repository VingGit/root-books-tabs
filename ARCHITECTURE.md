# Architecture

Root Books Workspace is an orchestration layer rather than a second
implementation of its companion plugins.

- `main.ts` owns lifecycle only.
- `integrations.ts` keeps one adapter descriptor per companion plugin.
- `note-rules.ts`, `new-note-pipeline.ts`, and `created-from-filename.ts` own
  the note-creation and date pipeline.
- `sorting.ts` coalesces the few workflow events that legitimately require a
  Custom Sort refresh.
- `book-metadata.ts` is the only writer for shared `panel` appearance metadata.
- `decorations.ts` adds passive UI to ordinary Obsidian leaves without routing
  or restoring workspace state.

The shared Quartz/Obsidian contract is intentionally limited to direct hex
colors and `lucide:<kebab-name>` icon identifiers. Obsidian-specific settings
remain in plugin data rather than frontmatter.
