# Scope Tabs agent instructions

## Product intent

Scope Tabs is an Obsidian desktop community plugin for vaults organized as multiple first-level-folder “books”. It exists primarily to make offline browsing of vaults published with `VingGit/root-index-panels` feel coherent, and is designed to compose with file-explorer focus plugins such as Explorer Focus rather than replace them.

Do not broaden the product into a generic workspace manager without an explicit request. The plugin owns **scope-aware navigation and book-context decoration**.

## Non-negotiable behavior

- A book is currently exactly one first-level vault folder.
- Root-level files are unscoped and use normal Obsidian behavior.
- With fewer than two first-level folders, routing interception must be a no-op.
- Same-book navigation creates a new tab in the same book group.
- Cross-book navigation reuses the destination book group if possible; otherwise create one according to settings.
- Explicitly created user destination leaves/windows must be respected.
- A manually created pop-out window is free navigation space unless Scope Tabs created/adopted it as a managed book group.
- Plugin unload must restore patched runtime behavior and remove plugin-created DOM/style state.
- No telemetry, network calls, or file access outside the vault.

## Architecture

Keep these responsibilities separate:

1. `src/scope.ts` — maps files to `BookScope` objects. Today only first-level folders are implemented. Future depth/config/plugin integrations belong behind the same abstraction.
2. `src/navigation.ts` — decides where a file opens. It must not know how Explorer Focus works.
3. `src/colors.ts` — resolves colors and mutates only the configured per-book Markdown config files.
4. `src/decorations.ts` — all DOM-sensitive visual work. Keep Obsidian selector assumptions here.
5. `src/settings.ts` — settings rendering and user-triggered management UI.
6. `src/main.ts` — lifecycle and registrations only.

Avoid moving DOM queries into navigation or scope resolution.

## Public API first

Prefer documented Obsidian APIs. Current core primitives include:

- `WorkspaceLeaf.openFile`
- `Workspace.getLeaf('tab')`
- `Workspace.createLeafBySplit(...)`
- `Workspace.openPopoutLeaf()`
- `Workspace.revealLeaf(...)`
- `WorkspaceLeaf.getRoot()`
- `FileManager.processFrontMatter(...)`
- `Plugin.loadData()` / `Plugin.saveData()`

If an undocumented/internal capability is unavoidable:

- feature-detect it;
- isolate it behind a small helper;
- provide a safe no-op/fallback;
- document why it exists;
- never make core routing correctness depend on it when avoidable.

The current left-tab reorder helper is such a compatibility path.

## Navigation interception rules

`WorkspaceLeaf.prototype.openFile` is patched deliberately so navigation sources converge at one point. Treat this as high-risk code.

When changing it:

- preserve the exact original function;
- never recursively call the patched method for plugin-created routing; call the saved original;
- guard against re-entry;
- restore the original method in `onunload()` only if `WorkspaceLeaf.prototype.openFile` still points at the exact Scope Tabs patch; never overwrite a patch installed later by another plugin;
- if the destination leaf differs from the active/source leaf, assume Obsidian/user explicitly chose it and respect it;
- do not interfere with unscoped root files;
- keep one managed tab group per book unless the user explicitly creates another destination.

## Color/config rules

Defaults:

- config base name: `index`
- frontmatter key: `color`
- value format: `#RRGGBB`

Rules:

- manual and frontmatter modes are mutually exclusive;
- first-level folders are detected from the vault, not a stored folder list;
- generate dark-theme-visible fallback colors deterministically;
- never duplicate the color key;
- use `FileManager.processFrontMatter()` for existing Markdown files;
- never overwrite an existing config note;
- creating a missing config note is user-triggered;
- missing-note notifications must be suppressible permanently.

## Decoration rules

- Book label is colored and subtle, not a heading in the note file.
- All tabs may carry book color, but active tab must have a subtle brighter state.
- Explorer coloring applies only to the active note's first-level folder.
- Custom CSS must expose/use `--scope-tabs-book-color` and `data-scope-tabs-book` hooks.
- Custom CSS is local text persisted in plugin settings. Never download CSS.

## Book controls

Managed book groups expose close, pop-out, and minimize controls.

- Close: detach all leaves in that book group.
- Pop-out: preserve files/tabs as well as possible using public workspace operations.
- Minimize: preserve the group object/location and visually collapse its content; navigating to the group restores it.
- Do not add Electron remote APIs solely to imitate operating-system window minimize. Pop-out windows already have native window controls.

## Settings/versioning

- `manifest.json` ID is `scope-tabs` and must never change after public release.
- Keep `manifest.json`, `package.json`, `package-lock.json`, and `versions.json` version/package metadata aligned; `npm ci` must remain reproducible.
- Settings persist using `loadData`/`saveData`; migrations should be additive and backward compatible.
- The plugin is desktop-only while pop-out/book-window functionality is part of the core feature set.

## Build and verification

Before shipping a code change:

```bash
npm ci
npm run build
npm run lint
```

Then manually test in a disposable vault containing at least:

```text
Book A/a.md
Book A/b.md
Book B/a.md
Book B/b.md
Book C/a.md
```

Also test a single-folder vault to verify Scope Tabs is inert.

Use `.github/prompts/` for repeatable task-specific workflows. Repository-wide always-on Copilot context belongs in `.github/copilot-instructions.md`; do not duplicate large task prompts there.
