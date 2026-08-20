# Root Books Tabs agent instructions

## Product intent

Root Books Tabs is an Obsidian desktop community plugin for vaults organized as multiple first-level-folder “books”. It exists primarily to make offline browsing of vaults published with `VingGit/root-index-panels` feel coherent and includes its own focused file-explorer book mode.

Do not broaden the product into a generic workspace manager without an explicit request. The plugin owns **scope-aware navigation and book-context decoration**.

## Non-negotiable behavior

- A book is currently exactly one first-level vault folder.
- Root-level files are unscoped and use normal Obsidian behavior.
- With fewer than two first-level folders, routing interception must be a no-op.
- Same-book navigation reuses an existing destination tab, otherwise creating a new tab in the same book group.
- Cross-book navigation reuses the destination book group if possible; otherwise create one according to settings.
- Explicitly created user destination leaves/windows must be respected.
- A manually created pop-out window is free navigation space unless Root Books Tabs created/adopted it as a managed book group.
- A homogeneous free duplicate may expose book controls, but moving it must preserve free ownership and must not replace the canonical group.
- Plugin unload must restore patched runtime behavior and remove plugin-created DOM/style state.
- No telemetry, network calls, or file access outside the vault.

## Architecture

Keep these responsibilities separate:

1. `src/scope.ts` — maps files to `BookScope` objects. Today only first-level folders are implemented. Future depth/config/plugin integrations belong behind the same abstraction.
2. `src/navigation.ts` — decides where a file opens and owns the canonical managed/free group registry.
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
- `Workspace.setActiveLeaf(...)`
- `WorkspaceLeaf.getRoot()`
- `WorkspaceLeaf.getViewState()` / `WorkspaceLeaf.setViewState(...)`
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
- restore the original method in `onunload()` only if `WorkspaceLeaf.prototype.openFile` still points at the exact Root Books Tabs patch; never overwrite a patch installed later by another plugin;
- if the destination leaf differs from the active/source leaf, assume Obsidian/user explicitly chose it and respect it;
- do not interfere with unscoped root files;
- keep one managed tab group per book unless the user explicitly creates another destination.
- Spiral placement fills a clockwise 2x2 base, then cycles over those four stable base books and halves them right/down/left/up.
- Grid placement fills a configurable 2–16 by 2–16 rectangle clockwise. Later books cycle over the stable base books and split each base in the configured right/down/left/up overflow direction.
- Grid and Spiral overflow must halve only the target base cell. A small feature-detected nested-`WorkspaceSplit` adapter may prevent Obsidian from flattening same-axis overflow into the surrounding row/column; public `createLeafBySplit` is the safe fallback.

## Color/config rules

Defaults:

- config base name: `index`
- frontmatter key: `color`
- value format: `#RRGGBB`
- tab text key: `tab-text-bg` (legacy key name, applied to every tab style)
- tab text value: `black`, `white`, or any valid CSS hex color; invalid/missing frontmatter falls back to white

Rules:

- manual and frontmatter modes are mutually exclusive;
- first-level folders are detected from the vault, not a stored folder list;
- generate dark-theme-visible fallback colors deterministically;
- calculate the default manual black/white tab foreground from WCAG relative luminance whenever its book background changes;
- never duplicate the color key;
- use `FileManager.processFrontMatter()` for existing Markdown files;
- never overwrite an existing config note;
- creating a missing config note is user-triggered;
- missing-note notifications must be suppressible permanently.

## Decoration rules

- Book label is colored and subtle, not a heading in the note file.
- All tabs may carry book color, but active tab must have a subtle brighter state.
- Manual/frontmatter tab text color applies to every tab color style.
- Book mode keeps the dropdown-selected book as its first/primary tree. Other books with open files appear below in logical opening order; when the primary's final tab closes, the latest remaining book is promoted to primary.
- Visible primary/temporary book bars may receive their corresponding book color.
- Custom CSS must expose/use `--scope-tabs-book-color` and `data-scope-tabs-book` hooks.
- Custom CSS is local text persisted in plugin settings. Never download CSS.

## Book controls

Managed book groups expose close, main/pop-out transfer, and whole-pop-out pinning through a book-icon pseudo-tab menu.

- Close: detach all leaves in that book group.
- Pop-out: preserve files/tabs as well as possible using public workspace operations.
- Managed pop-outs may use a feature-detected Obsidian Electron window handle for an explicit whole-book always-on-top pin only.
- Pop-out book menus must remain visible and provide Return book to Obsidian; returning secondary books append at the configured expansion end.
- Pop-out detection must not rely only on `instanceof WorkspaceWindow`; use the leaf's owner document as a cross-realm fallback.
- Native closure of a managed pop-out returns its cached tabs to the main workspace; intentional Close book/move operations suppress that return.
- The book pseudo-tab is also a whole-group drag handle. Drop placement must transfer all public view states and preserve managed/free ownership; a drag outside the main window may create a pop-out.
- Every book pseudo-tab menu offers explicit all-tab regrouping, and a stationary long press invokes the same action. Regrouping preserves view states and active focus; animation must honor reduced-motion preference.
- Secondary explorer close bars advertise Shift instance selection and Ctrl-click close-all. Instance hover must still identify the exact target group.

## Settings/versioning

- The display name and repository are Root Books Tabs / `root-books-tabs`. Retain the legacy `manifest.json` ID `scope-tabs` and `scope-tabs-*` CSS/data hooks for settings and custom-CSS compatibility.
- Keep `manifest.json`, `package.json`, `package-lock.json`, and `versions.json` version/package metadata aligned; `npm ci` must remain reproducible.
- Settings persist using `loadData`/`saveData`; migrations should be additive and backward compatible.
- New-note and new-folder placement are independent. Folder placement may wrap the feature-detected app-instance `createNewFolder` method because no public parent hook exists; explicit folder arguments must pass through.
- Managed/free group metadata, logical book order, and up to 256 stable Grid base-book IDs are versioned separately from user settings. Group ownership is persisted only through feature-detected group IDs.
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

The default local playground is `C:\Users\Admin\quartz-vaults\test-vault`.

Also test a single-folder vault to verify Root Books Tabs is inert.

Use `.github/prompts/` for repeatable task-specific workflows. Repository-wide always-on Copilot context belongs in `.github/copilot-instructions.md`; do not duplicate large task prompts there.
