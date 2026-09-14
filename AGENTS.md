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
- Grid placement fills a configurable 2–16 by 2–16 rectangle left to right, row by row; after all base cells are filled, overflow cycles through all cells. Later books cycle over the stable base books and split each base in the configured right/down/left/up overflow direction.
- Grid overflow must halve only the target base cell. A small feature-detected nested-`WorkspaceSplit` adapter prevents Obsidian from flattening same-axis overflow into the surrounding row/column before delegating leaf creation to public `createLeafBySplit`.
- Plugin-created pop-outs should open on the source Obsidian window's display. Pass feature-detected `screenX`/`screenY` coordinates through public `Workspace.openPopoutLeaf(data)` and keep Obsidian's default placement as the safe fallback.

## Color/config rules

Defaults:

- config base name: `index`
- frontmatter key: `color`
- value format: `#RRGGBB`
- tab text key: `tab-text-bg` (legacy key name, applied only to the Background tab style)
- tab text value: `black`, `white`, or any valid CSS hex color; invalid/missing frontmatter falls back to white

Rules:

- Colors are automatic local fallbacks with optional book-frontmatter overrides. Do not expose a manual/frontmatter mode selector.
- first-level folders are detected from the vault, not a stored folder list;
- generate dark-theme-visible fallback colors deterministically;
- default every manual Background tab foreground to white until the user explicitly switches that book to black;
- never duplicate the color key;
- use `FileManager.processFrontMatter()` for existing Markdown files;
- never overwrite an existing config note;
- Missing config notes are created for new books when enabled (default true), fresh-clone entry into an empty book, and ordering preparation. Preserve all existing properties and note bodies.
- missing-note notifications must be suppressible permanently.

## Decoration rules

- Book label is colored and subtle, not a heading in the note file.
- All tabs may carry book color, but active tab must have a subtle brighter state.
- Manual/frontmatter tab text color applies only to the Background tab color style; other styles retain Obsidian's text color.
- Manual foreground controls belong in the Background-style conditional settings, not the manual book-color rows.
- Book mode keeps the dropdown-selected book as its first/primary tree. Other books with open files appear below in logical opening order; when the primary's final tab closes, the latest remaining book is promoted to primary.
- Visible primary/temporary book bars may receive their corresponding book color.
- Custom CSS must expose/use `--scope-tabs-book-color` and `data-scope-tabs-book` hooks.
- Custom CSS is local text persisted in plugin settings. Never download CSS.
- Excluded first-level folders stay outside the book system and automatic config generation. Their files share one dedicated non-book tab group, placed beside the active group by default or in a pop-out when configured. The portable exclusion list defaults to `templates`; excluded folders do not count toward book routing. Book pickers expose one checked count action that slides open their native explorer trees in a dotted, labeled panel above the main selector. Its X button and the menu action close it, and its open state survives book-mode toggles and native tree refreshes.

## Book controls

Managed book groups expose close, main/pop-out transfer, and whole-pop-out pinning through a book-icon pseudo-tab menu.

- Close: detach all leaves in that book group.
- Pop-out: preserve files/tabs as well as possible using public workspace operations.
- Managed pop-outs may use a feature-detected Obsidian Electron window handle for an explicit whole-book always-on-top pin only.
- Pop-out book menus must remain visible and provide Return book to Obsidian; returning secondary books append at the configured expansion end.
- Pop-out detection must not rely only on `instanceof WorkspaceWindow`; use the leaf's owner document as a cross-realm fallback.
- Native closure of a managed pop-out returns its cached tabs to the main workspace; intentional Close book/move operations suppress that return.
- The book pseudo-tab is also a whole-group drag handle. Drop placement must transfer all public view states and preserve managed/free ownership; a drag outside the main window may create a pop-out.
- Every book pseudo-tab menu offers explicit all-tab regrouping, and a stationary long press invokes the same action. Regrouping preserves view states and active focus; in Grid mode it returns managed pop-outs and rebuilds the configured row-major layout. Any Grid row or column change triggers the same layout refill automatically. Animation must honor reduced-motion preference.
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

## Portable configuration and ordering

- Vault-wide settings belong in root `index.md` frontmatter. Create the note if missing and add missing defaults without deleting unrelated fields. Root config never represents a book. Local CSS, runtime ownership, selected book and automatic colors remain local.
- `isFreshClone` and `freshCloneOpeningPath` govern one-time portable startup; consume the Boolean only after startup handling. Invalid paths preserve restored state, otherwise use the most recently edited note.
- Book overrides belong only in that book's root config note. Folder order metadata belongs in each folder's config note.
- Each non-root folder config owns a `fileOrder` array of exact immediate-child names, excluding the config note itself. Reconcile stale/new names without disturbing surviving manual order. The config note is pinned independently at the portable top/bottom position, default top. Ordering types are manual, alphabetical and creation-date, with global ascending/descending direction defaulting to descending and `forcedOrderingType` false or one of those three values. Ordering mode is scoped to one book, keeps the dimmed workspace inert, collapses a dragged folder temporarily, rejects its descendants as targets, and restores native folder state/UI on exit or unload. Clicking the dimmed area or the red X reorder control exits.
- Cross-directory moves of root or folder config notes are guarded through an ownership-safe `FileManager.renameFile` wrapper. The safe default leaves both paths unchanged; an explicit or locally remembered choice may merge/replace frontmatter, append/replace bodies, or swap user data while location-owned fields stay with their folders. Reset clears the remembered choice.
- All managed frontmatter fields accept `book-tabs-` aliases, and prefixed values take precedence. Existing prefixed fields are plugin-owned. Preserve an unowned plain collision and write the plugin value to the prefixed alias; generated help comments must attach only to the plugin-owned key.
- Root and folder config notes may define separate `template-md`, `template-canvas`, and `template-base` mappings. Each has one same-extension vault-relative path mapped to `[date format, filename prefix, apply filename convention]`. Missing folder mappings inherit atomically from the nearest parent and then root; empty mappings disable that type. Markdown defaults to `example.md: [DD.MM.YYYY, "{{date}}_", true]`; Canvas and Base default off. `template-folder` defaults to `templates`: bare root paths use it, while folder overrides use it for every custom path when `template-paths-under-global-folder` is true (default). Saving overrides creates only missing same-type template files and parent folders; never overwrite a template.
- Keep Obsidian's automatic internal-link update setting enabled when the portable `forceUpdateLinks` option is true. It defaults to true after install and reset.
- Hide manager writes escaped, root-anchored literal paths to `.obsidianignore` and preserves unrelated rules. Session reveal must not rewrite persistent exclusions.
- Every settings group gets its own distinct section. Choose a suitable section for future settings, or add one.
- Keep README and task prompts synchronized with durable behavior. Temporary `.github/temp` handoff notes must be deleted after their accepted behavior and useful findings are incorporated into these durable files.
