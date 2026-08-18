# Scope Tabs agent instructions

## Product intent

Scope Tabs is an Obsidian desktop community plugin for vaults organized as multiple first-level-folder “books”. It exists primarily to make offline browsing of vaults published with `VingGit/root-index-panels` feel coherent, and is designed to compose with file-explorer focus plugins such as Explorer Focus rather than replace them.

Do not broaden the product into a generic workspace manager without an explicit request. The plugin owns **scope-aware navigation and book-context decoration**.

## Non-negotiable behavior

- A book is currently exactly one first-level vault folder.
- Root-level files are unscoped and use normal Obsidian behavior.
- With fewer than two first-level folders, routing and decoration must be a no-op.
- Same-book navigation creates a new tab in the same book group.
- Cross-book navigation reuses the destination book group if possible; otherwise create one according to settings.
- Explicitly created user destination leaves/windows must be respected.
- A manually created pop-out window is free navigation space unless Scope Tabs created/adopted it as a managed book group.
- Plugin unload must restore patched runtime behavior and remove plugin-created DOM/style state.
- No telemetry, network calls, or file access outside the vault.

## Architecture

Keep these responsibilities separate:

1. `src/scope.ts` maps files to `BookScope` objects. Today only first-level folders are implemented. Future depth/config/plugin integrations belong behind the same abstraction.
2. `src/navigation.ts` decides where a file opens. It must not know how Explorer Focus works.
3. `src/colors.ts` resolves colors and mutates only configured per-book Markdown config files.
4. `src/decorations.ts` owns all DOM-sensitive visual work.
5. `src/settings.ts` owns settings rendering and user-triggered management UI.
6. `src/main.ts` owns lifecycle and registrations only.

## Public API first

Prefer documented Obsidian APIs: `WorkspaceLeaf.openFile`, `Workspace.getLeaf('tab')`, `Workspace.createLeafBySplit`, `Workspace.openPopoutLeaf`, `Workspace.revealLeaf`, `WorkspaceLeaf.getRoot`, `FileManager.processFrontMatter`, and `Plugin.loadData`/`saveData`.

If an undocumented/internal capability is unavoidable, feature-detect it, isolate it, provide a safe fallback, document why it exists, and avoid making core routing depend on it. The current left-tab reorder helper is such a compatibility path.

## Navigation interception rules

`WorkspaceLeaf.prototype.openFile` is patched deliberately. Preserve the exact original function, never recursively call the patched method for plugin-generated routing, guard re-entry, restore the original in `onunload`, respect an explicitly different destination leaf, and do not interfere with unscoped root files.

## Color/config rules

Defaults: config base name `index`, frontmatter key `color`, value format `#RRGGBB`.

Manual and frontmatter modes are mutually exclusive. Detect first-level folders from the vault. Never duplicate the color key. Use `FileManager.processFrontMatter()` for existing files. Never overwrite an existing config note. Creating a missing note is user-triggered. Missing-note notifications must be suppressible permanently.

## Decoration rules

Book labels are visual UI, never written as note headings. Active tabs use a subtly brighter book color. Explorer coloring applies only to the active note's first-level folder. Keep `--scope-tabs-book-color` and `data-scope-tabs-book` as stable custom-CSS hooks.

## Book controls

Managed groups expose close, pop-out, and minimize. Do not introduce Electron remote APIs solely to imitate OS-level minimization; pop-outs retain native window controls.

## Settings/versioning

- `manifest.json` ID is `scope-tabs` and must never change after public release.
- Keep `manifest.json`, `package.json`, and `versions.json` versions aligned.
- Settings persist with `loadData`/`saveData`.
- The plugin is desktop-only while pop-out/book-window behavior is core.

## Build and verification

Run `npm ci`, `npm run build`, and `npm run lint`. Manually test at least three first-level books plus a single-folder vault. Use `.github/prompts/` for repeatable task-specific workflows.
