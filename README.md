# Root Books Tabs

Root Books Tabs was created to make it easier to browse **offline Obsidian vaults that are also published with [root-index-panels](https://github.com/VingGit/root-index-panels)**. Its integrated book mode focuses the file explorer on one book while its routing keeps that book's notes and resources together.

In the spirit of root-index-panels, **every first-level folder in the vault is treated as a separate “book.”** That book boundary is the default scope that drives tab groups, splits/pop-out windows, book colors, and the small book label shown above notes.

If a vault does not contain at least two first-level folders, Root Books Tabs does nothing to navigation.

> **Status:** `0.1.8` is the current development build. The routing core uses Obsidian workspace APIs; a few visual compatibility features necessarily touch Obsidian's DOM or tab-group internals and are isolated so they can be repaired without changing the scope/navigation model.

## Core model

```text
Vault/
├── Programming/        ← book
│   ├── index.md
│   ├── Python.md
│   └── Java.md
├── History/            ← book
│   ├── index.md
│   └── Rome.md
└── Security/           ← book
    ├── index.md
    └── SSH.md
```

A file is scoped only by its **first path element**. The current implementation deliberately does not expose configurable scope depth yet, but scope resolution is isolated in `src/scope.ts` so another resolver can be added later.

Files stored directly in the vault root have no book scope and keep normal Obsidian behavior.

## Navigation behavior

### Same book

Navigating within the same first-level folder reuses the destination tab when it is already open. Otherwise it opens the destination in a **new tab in the same book tab group**. This applies to every file-backed view, including Markdown, images, PDFs, Canvas, and Bases.

Settings control:

- whether a new tab is appended at the group's **right of the current tab** (default) or appended at the **end**;
- whether a same-book note replaces the current tab, opens in a background tab, or opens in a new focused tab;
- optional per-book overrides for that opening mode, available both in settings and each book pseudo-tab menu.

Book labels on Markdown, Canvas, Bases, images, PDFs, and other file-backed views include accessible back/forward buttons colored with the book color when enabled. Obsidian's duplicate view-header arrows are hidden for book-scoped files; root-level and excluded files keep native arrows. In same-tab mode the book buttons traverse page history in the current tab. In either new-tab mode they move through that book's tabs in the group's live left-to-right order. Closing, dragging, cross-book mixing, or regrouping tabs changes that order immediately, while tabs from other books are skipped. Each main, pop-out, or duplicate group remains independent.

### Different book

Navigating to a note whose first-level folder differs from the current note opens/reuses that book's tab group and focuses it.

A new book can be opened:

- right of the current group (default);
- left;
- above;
- below;
- in a configurable **Grid** from 2–16 rows and 2–16 columns, which fills its base cells left to right, row by row, and then revisits every base cell in that order, splitting each one in the configured overflow direction;
- in an external Obsidian pop-out window.

Grid exposes row and column sliders plus exact number inputs; both default to 2 and accept 2–16. It fills the configured rectangle left to right, row by row. Once that rectangle is full, later books revisit all its stable base cells in the same order and split each base cell in the selected overflow direction. The **Overflow** selector stays to the left of the main position selector.

Root Books Tabs keeps **one canonical managed tab group per book**, located either in the main workspace or a pop-out. If the requested file is already open there, its existing tab is focused; otherwise a new tab is added.

The dropdown-selected book is the primary, first book in the managed-book order. New main-workspace groups are appended from the current end of that order using the configured direction. If the primary book's last tab closes, the most recently opened remaining book is promoted exactly as if it had been selected from the dropdown.

Changing the main-book dropdown closes every main and pop-out instance of the previous book by default, leaving only the newly selected book plus books opened explicitly through links or **Open another book**. A compatibility radio keeps the earlier behavior where the previous book remains open.

File-explorer activation has its own routing choice. The default opens a scoped file in the most recently opened matching book instance, creates a dedicated group when none exists, and raises a matching pop-out. The compatibility option routes into the currently focused book group. Both choices still honor the global/per-book same-tab, background-tab, or focused-tab mode and keep histories isolated by group. Root-level files continue to use normal Obsidian behavior.

The root config's `freshCloneOpeningPath` opens once when `isFreshClone` is true, then the Boolean becomes false and subsequent openings restore the normal workspace. Reset the Boolean in settings or edit it in root `index.md` before sharing a vault.

### Explicit user windows

Root Books Tabs respects a destination leaf that Obsidian or the user explicitly created. Such an extra group is a **free exception** and ordinary navigation from it remains there. Unknown pop-outs are never silently adopted as canonical book groups.

When a free group contains pages from only one book, it still receives that book's pseudo-tab controls. Moving or returning it preserves its free-group status and does not replace the canonical instance.

### Book controls

Every homogeneous book group receives a small book pseudo-tab before its first page tab, including separated duplicate instances and pop-outs. Click it for the group menu, or drag it as a whole-book group handle. Edge markers show where the complete group will be placed; dragging out of the main Obsidian window creates a pop-out, and dropping a pop-out handle onto a main-workspace group returns it there. Its menu provides:

- **Pin / unpin pop-out book** — available only in a pop-out, and keeps that entire book window above other windows.
- **Move to pop-out / Return book to Obsidian** — reproduces every view state and active tab at the new location, then removes the old group. A returning secondary book is appended at the configured expansion end.
- **Sort all tabs into books** — consolidates scoped tabs into their corresponding book groups, removes duplicate tabs for the same book file across every instance and pop-out, and preserves the surviving active view. In Grid mode it also returns managed pop-outs and rebuilds the open books in the configured row-major Grid. A stationary long press on any book pseudo-tab runs the same action; a short animation is skipped when reduced motion is requested.
- **Close book** — closes every tab in the book group.

Pinning uses Obsidian's feature-detected desktop window handle and applies to the whole pop-out, never an individual note. Closing a managed pop-out with its native window control returns its cached tabs and active view to the main workspace; an intentional **Close book** does not restore it.

## Book colors

Book colors are automatic, with optional frontmatter overrides. Automatic colors are stored locally and survive resetting settings. Use **Per book config → Add color override** to set a book color and Background-style foreground together, or remove an override to roll a new local color.

Root Books Tabs looks for a Markdown config note in every first-level folder.

Defaults:

```text
config note:       index.md
color property:    color
tab text property: tab-text-bg
```

Example:

```yaml
---
book-tabs:
  color: "#69b7ff"
  tab-text-bg: black
---
```

`tab-text-bg` accepts `black`, `white`, or any valid CSS hex color. It applies only to the Background tab style. A missing or invalid value resolves to white without writing an automatic value into the note. Its property-name setting also appears only while Background is selected.

The filename is entered in settings **without `.md`**.

When a config note exists but the configured color property is missing or invalid, Root Books Tabs uses its local automatic color. Explicit overrides use `FileManager.processFrontMatter()` and preserve unrelated properties. Plugin settings and color overrides are written inside the dedicated `book-tabs:` mapping. Section values win over readable legacy `book-tabs-` aliases; migration removes plugin-owned legacy duplicates while preserving unrelated top-level properties.

Every new book receives its config note automatically. The **Book config notes** action creates missing notes or regenerates missing defaults without replacing unrelated frontmatter or note bodies. A separate toggle controls missing-config notifications.

## Visual book markers

### Note label

Enabled by default. A small colored book name and navigation arrows are inserted above every supported file-backed view.

### Tabs

Tab coloring is enabled by default. Available styles:

- underline;
- full colored background;
- colored dot before the tab title;
- custom CSS.

The active tab uses a subtly brighter variant of the same book color.

### Book-mode explorer

Book mode is enabled by default and can be toggled from the file-explorer action bar or the command palette. It replaces the hand-selected first-level folder row with a book bar and shows that folder's contents directly beneath it. Clicking the book name opens that book's configured folder note (`index.md` by default); the separate chevron changes the persistent primary selection. A secondary book's colored name also opens its folder note, and its adjacent X is the close control. Folder-note openings use the same per-book same-tab, background-tab, or focused-tab rule as ordinary file-tree notes. Every subfolder inside a book becomes a folder note whenever its configured note exists: click its name to open the note or its arrow to expand/collapse the tree. A folder's context menu can create the note when it is missing. The vault-root `index.md` and all book/folder config-note rows are hidden in both book mode and the normal file explorer; the file-explorer toolbar opens the vault config in a standalone pop-out. This hiding does not add paths to `.obsidianignore`, and existing ignore rules remain unchanged. First-level folders in the portable exclusion list stay outside the book system; `templates` is excluded by default. Files from all excluded folders share one dedicated tab group, placed immediately to the right of the active group by default or in a pop-out when selected in settings. Each book menu has a checked **Show N excluded folders** action. Enabling it slides open a larger-dotted **Excluded folders** panel above the main book selector, retaining normal Obsidian titles, arrows, nesting, file behavior, and usable native context menus. Its open state and position survive book-mode toggles and native file-tree refreshes. The X on its legend or the checked menu action closes it and slides the books back up.

Opening another book does not replace that primary tree. The **Open another book** action stays directly after the primary book's complete file tree and before every secondary book tree, so changing the primary book preserves that relationship. Its menu always offers book creation and lists unopened books; Shift-clicking an unopened book opens it in a pop-out. Plugin-created pop-outs are placed on the source Obsidian window's display through Obsidian's desktop API when window coordinates are available. Its hover explanation wraps inside narrow explorers. A red **Close all** action beside it closes every secondary book in the main workspace and pop-outs while leaving every primary-book group and tab untouched. Each additional book with an open note/resource appears in opening order as its own flattened, colored subtree and disappears when its last file is closed. Book mode coordinates with Obsidian's virtualized explorer model: it expands detached folder items deterministically, changes the logical root order instead of applying CSS order, and invalidates native height caches after decoration. This keeps every subtree recoverable while scrolling through a full vault. If the primary book closes, the newest remaining subtree is promoted to primary. Disabling book mode restores every normal root item and its native order, then removes all injected bars and classes.

The secondary explorer X explains both close modifiers on hover. Shift-click opens a tree of group/window instances and every live tab; hovering an entry gives the exact target an unmistakable red close preview without focusing its leaf. A covered pop-out is temporarily raised without activation for that preview, then returned behind the explorer window. Ctrl-click closes every instance and stray tab of that book. An ordinary click closes the latest instance. The compact tree button to the left opens the same close picker and doubles as a drag handle for reordering secondary books vertically; the persisted logical order drives both the explorer and later openings. Pseudo-tab menu actions retain their existing behavior.

The configured index note is the preferred entry page when a book is opened from the dropdown or **Open another book** menu. If it is missing, Root Books Tabs walks only that book's folder tree and opens its shallowest Markdown file, falling back to another resource. It never calls Obsidian's whole-vault file enumeration APIs for this lookup.

Custom CSS can use:

```css
--scope-tabs-book-color
--scope-tabs-tab-text-color
[data-scope-tabs-book]
```

Custom tab CSS is edited in a responsive modal with examples and a shadow-isolated active/inactive preview. Apply saves the draft; Cancel discards it. The CSS is stored locally and never downloaded.

## New note and folder placement

New Markdown notes and toolbar-created folders have independent settings: use the focused note's folder (default) or its book root. An explicitly chosen explorer folder still wins. With only Obsidian's forced empty tab present, new notes/folders use the selected book root; the first opened note adopts that empty tab and receives its book menu immediately. New notes route to the canonical managed group, including a pop-out, which is focused and brought forward.

## Settings persistence

Root Books Tabs stores vault-wide settings in the root `index.md` frontmatter. Local CSS, automatic colors, selected book and runtime group ownership use Obsidian's `Plugin.loadData()` / `Plugin.saveData()` mechanism. The legacy plugin ID remains `scope-tabs` so existing settings and installed vault folders continue to work:

```text
.obsidian/plugins/scope-tabs/
```

Config creation, portable settings, color overrides, folder templates, exclusions, ordering direction, and automatic-link maintenance update frontmatter while preserving unrelated properties and note bodies.

Use **Reset to defaults** in the settings page to restore the default configuration. Local automatic book colors are preserved.

## Privacy and offline use

Root Books Tabs is designed for offline vault use.

- No telemetry.
- No external service.
- No network request.
- No remote code.
- No reading or writing outside the vault.

Note-content changes are limited to the configuration and ordering metadata described above.

## Development

Requirements:

- Node.js 20+ recommended;
- npm.

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run build
npm run lint
```

For local testing, place/clone the repository at:

```text
<Vault>/.obsidian/plugins/scope-tabs/
```

Run `npm run dev`, reload Obsidian, then enable **Root Books Tabs** under **Settings → Community plugins**.

The repository's default disposable playground is `C:\Users\Admin\quartz-vaults\test-vault`.

## Architecture

```text
src/
├── main.ts             plugin lifecycle and registrations
├── scope.ts            first-level-folder scope resolver
├── navigation.ts       navigation interception and book-group routing
├── leaf-file.ts        file resolution for Markdown and resource views
├── new-note.ts         ownership-safe new-note parent policy
├── colors.ts           automatic/override colors and config migration
├── book-order.ts       portable folder ordering and body edit timestamps
├── config-frontmatter.ts namespaced fields and YAML help preservation
├── index-move.ts       guarded config-note transfer policy
├── templates.ts        inherited folder templates for new files
├── vault-config.ts     portable root index settings
├── decorations.ts      note, tab, explorer, and book-group UI decoration
├── settings.ts         settings UI and missing-config modal
├── settings-model.ts   defaults and input normalization
└── types.ts            shared settings/domain types
```

The important design boundary is:

```text
scope resolution → routing decision → workspace operation → decoration
```

Book-mode explorer behavior is implemented locally. Routing does not depend on root-index-panels or any other plugin.

## Known compatibility boundary

Obsidian exposes the core leaf, split, tab, and pop-out primitives required for routing. It does **not** expose every visual tab-header/file-explorer operation as a stable public API.

Consequently:

- left-side tab insertion uses a feature-detected tab-group compatibility path;
- tab-header decoration and file-explorer decoration depend on Obsidian DOM class names;
- these pieces are intentionally kept in `src/decorations.ts` / the tab-order helper in `src/navigation.ts`.

If an Obsidian update changes those internals, normal routing should remain repairable independently of visual compatibility code.

## Release files

An Obsidian release must attach these files individually:

```text
main.js
manifest.json
styles.css
```

After every successful build matrix on `main`, GitHub Actions validates the version metadata and automatically creates an exact, unprefixed version tag and public release. Repeated runs compare immutable release assets and require a version bump if the build has changed.

## License

0BSD. See `LICENSE`.

## Portable configuration and ordering

Vault-wide options are stored in the vault root `index.md` frontmatter. Existing properties and note content are preserved. `freshCloneOpeningPath` accepts a Markdown note or first-level book folder; `isFreshClone: true` applies it once and then resets to false. A book uses its config note, newest note, or a newly created config note in that order. An invalid path preserves restored workspace state; without saved state, the newest note is used.

Plugin settings live in a dedicated `book-tabs:` YAML mapping: globally in the root `index.md`, and locally in folder config notes. A section manager migrates comment-owned legacy properties and `book-tabs-` aliases, preserves unrelated fields, and writes settings in a uniform order. Existing section values win. Shared note metadata (`creation-date`, folder aliases and display titles, PreviousArticle, NextArticle, SeeAlso) stays at the top level for companion-plugin compatibility. Delete the mapping to remove plugin settings from a note; pause automatic regeneration when reviewing configuration from scratch.

The explorer sort button offers alphabetical, creation date, and properties. Manual file ordering, drag-order mode and `fileOrder` are retired; legacy plugin-owned copies are removed during migration. The adjacent direction button changes the global ascending/descending default, initially descending. A folder’s `book-tabs.forcedOrderingType` and `book-tabs.forcedOrderingDirection` override its inherited order and direction; `false` inherits. Properties sorting follows explicit Previous/Next links only between immediate children of the same folder. Links leaving the folder do not form ordering edges. Disconnected chains and missing links use valid configured date substrings in filenames, then creation-date frontmatter, then filesystem creation time, then alphabetical names. Descending reverses that same sequence. Config-note transfer protection and whole-book/tab reordering remain independent.

Missing Previous/Next creation suggestions use Article Navigator’s default inline layout: two cards beneath the note, 16px apart, with 8px corners and Next aligned right. Suggestions show the final template-aware path, create reciprocal article links, and follow the book’s note-opening rules. Each X hides that suggestion for its folder.

Maintenance places selected-field regeneration and destructive frontmatter deletion beside each other. Regeneration restores only the chosen global setting or shared metadata field. Deletion previews the affected Markdown notes, backs up original content inside the vault’s plugin folder, preserves note bodies, and pauses automatic regeneration. Companion plugins can still maintain their own metadata. Keep regeneration paused during a setting-by-setting audit.

Hidden paths are managed through `.obsidianignore`; install the [Ignore plugin](https://community.obsidian.md/plugins/ignore) for vault-wide exclusion. The picker displays `./` paths and writes compatible root-anchored `/` patterns, escaped for literal filenames. Session reveal leaves the ignore file unchanged. The separate excluded-folder list removes selected first-level folders from the book system and automatic config generation. New books automatically receive config notes; config notes are hidden by explorer decoration and are never automatically added to `.obsidianignore`.

Book colors use local automatic fallback colors, retained across settings resets. Add an override to write color and Background-style foreground into the book config note; removing it rolls a fresh local fallback. Applying config names migrates existing notes/keys and rejects conflicting destinations.

Book labels and navigation arrows appear above Markdown, Canvas, Bases, images and other Obsidian file views. Increasing Grid rows or columns automatically repopulates managed open books into the expanded row-major layout.

Folder templates have separate `template-md`, `template-canvas`, and `template-base` mappings in root or folder config notes. Each mapping contains one template path mapped to `[filename prefix, apply filename convention]`, for example `template-md: { example.md: ["{{date}}_", true] }`. The standalone **Date format** field is shared by all three types and date ordering, defaults to `DD.MM.YYYY`, and is stored as `template-date-format`. It sits below the global template folder and below the local book-relative switch; an empty local field inherits. Supported tokens are `YYYY`, `YY`, `MM`, `DD`, `HH`, `mm`, and `ss`. A missing folder mapping inherits atomically; an empty mapping disables that type. Markdown defaults to `example.md` under `templates` and a date prefix, with a 24-hour time suffix for same-date collisions. Canvas and Base default off. Turning filename treatment off still copies the template. Each type drawer contains template file, prefix, and filename-treatment controls. A disabled local override inherits; an enabled override with an empty template file explicitly disables that type. Legacy three-value mappings remain readable and migrate when saved.

Local **Excluded subfolders** lists paths relative to the selected folder, stored as `template-excluded-subfolders` in that folder's config note. Listed subtrees skip both template contents and filename prefixes, including descendant overrides.

Bare global template filenames resolve inside `template-folder`; global paths containing folders are exact vault-relative paths. Folder overrides use book-relative paths by default: `example.md` for the `aviation` book writes to `templates/aviation/example.md`, and `boards/blank.canvas` writes to `templates/aviation/boards/blank.canvas`. Turning the book-relative switch off makes `example.md` a vault-root path and treats paths with folders as exact vault-relative paths. The override form previews every destination and offers to shorten a path that already contains the template folder and book name. Saving overrides writes their mappings to the folder config note and creates missing parent folders and Markdown, Canvas, or Base template files without replacing existing files. If an older override used a shared file under `template-folder`, that file remains usable until Save; Save copies its contents to the new book-relative destination when the destination is missing. Template files cannot use the configured book config-note filename, and existing files or folders that block a destination require a renamed path before saving. Invalid Windows filename characters in generated prefixes are replaced with hyphens. Legacy Markdown template fields are read during migration and rewritten in the new format when their settings are saved.

`forceUpdateLinks` defaults to true and keeps Obsidian's automatic internal-link updating enabled while the plugin is active. Resetting Root Books Tabs restores this default and clears any remembered config-note move choice.

The command palette (and Obsidian slash commands when enabled) exposes show-note-frontmatter, standalone vault-config pop-out, and hide-opened-frontmatter actions. Assign any preferred shortcuts through Obsidian's Hotkeys settings.

Books containing only folder config notes display **Add your first note** in place of their tree, for both primary and secondary books. Subfolder names with existing folder notes remain underlined. Right-click a primary or secondary book name to rename it inline; left-click still opens its folder note with the usual book tab rules. Config aliases follow folder names (the root uses the vault name); editing that alias is repaired with a notice to rename its folder instead.

**Frontmatter display** defaults to **Inherit**, following Obsidian's **Properties in document** choice. Visible, Hidden, and Source apply locally to views opened through the plugin's frontmatter commands, and cleanup restores their prior state.

## Suggested plugins

[Property Over File Name](https://community.obsidian.md/plugins/property-over-file-name) makes repeated `index.md` files recognizable in search, graph views, and the quick switcher. Config-title maintenance defaults on, writes the parent folder name to `title` (vault name at root), and migrates the old property when its configured key changes. Following the installed plugin's key defaults on; unsupported or absent versions safely use the configured key.

[Article Navigator](https://community.obsidian.md/plugins/article-navigator) provides Previous, Next, and See Also navigation for diaries and tutorials. The integration follows its live property names when supported, otherwise uses `PreviousArticle`, `NextArticle`, and `SeeAlso`. Each property can be generated only where missing, across the vault or recursively in one selected folder. Population orders eligible notes by configured filename dates (preferred by default), then filesystem-backed creation dates, then paths. Exact paths, folder paths, or `/regex/flags` blacklist rules exclude notes; only root `index.md` is blacklisted by default. Replacing existing Previous/Next values opens a review of every before/after value, with file and folder exclusion actions that recalculate the remaining links.

Missing Previous/Next links get dotted creation cards with an editable name, final template-path preview, and Create. Creation applies the effective Markdown template once and writes reciprocal links. Each card's X persists `article-placeholder-hidden-previous` or `article-placeholder-hidden-next` in the current folder config. Set it to false, remove it, or use the restoration action to show suggestions again.
