# Root Books Tabs

Root Books Tabs was created to make it easier to browse **offline Obsidian vaults that are also published with [root-index-panels](https://github.com/VingGit/root-index-panels)**. Its integrated book mode focuses the file explorer on one book while its routing keeps that book's notes and resources together.

In the spirit of root-index-panels, **every first-level folder in the vault is treated as a separate “book.”** That book boundary is the default scope that drives tab groups, splits/pop-out windows, book colors, and the small book label shown above notes.

If a vault does not contain at least two first-level folders, Root Books Tabs does nothing to navigation.

> **Status:** `0.1.1` is the current development build. The routing core uses Obsidian workspace APIs; a few visual compatibility features necessarily touch Obsidian's DOM or tab-group internals and are isolated so they can be repaired without changing the scope/navigation model.

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

- whether the new tab is inserted to the **right** or **left**;
- whether the new tab receives focus automatically.

### Different book

Navigating to a note whose first-level folder differs from the current note opens/reuses that book's tab group and focuses it.

A new book can be opened:

- right of the current group (default);
- left;
- above;
- below;
- in a configurable **Grid** from 2–16 rows and 2–16 columns, which fills its base cells clockwise and then revisits them clockwise, splitting each one in the configured overflow direction;
- in an external Obsidian pop-out window.

Grid exposes row and column sliders plus exact number inputs; both default to 2 and accept 2–16. It fills the configured rectangle clockwise. Once that rectangle is full, later books revisit its stable base cells clockwise and split each base cell in the selected overflow direction. The **Overflow** selector stays to the left of the main position selector.

Root Books Tabs keeps **one canonical managed tab group per book**, located either in the main workspace or a pop-out. If the requested file is already open there, its existing tab is focused; otherwise a new tab is added.

The dropdown-selected book is the primary, first book in the managed-book order. New main-workspace groups are appended from the current end of that order using the configured direction. If the primary book's last tab closes, the most recently opened remaining book is promoted exactly as if it had been selected from the dropdown.

### Explicit user windows

Root Books Tabs respects a destination leaf that Obsidian or the user explicitly created. Such an extra group is a **free exception** and ordinary navigation from it remains there. Unknown pop-outs are never silently adopted as canonical book groups.

When a free group contains pages from only one book, it still receives that book's pseudo-tab controls. Moving or returning it preserves its free-group status and does not replace the canonical instance.

### Book controls

Every homogeneous book group receives a small book pseudo-tab before its first page tab, including separated duplicate instances and pop-outs. Click it for the group menu, or drag it as a whole-book group handle. Edge markers show where the complete group will be placed; dragging out of the main Obsidian window creates a pop-out, and dropping a pop-out handle onto a main-workspace group returns it there. Its menu provides:

- **Pin / unpin pop-out book** — available only in a pop-out, and keeps that entire book window above other windows.
- **Move to pop-out / Return book to Obsidian** — reproduces every view state and active tab at the new location, then removes the old group. A returning secondary book is appended at the configured expansion end.
- **Sort all tabs into books** — consolidates scoped tabs into their corresponding book groups while preserving view state and focus. A stationary long press on any book pseudo-tab runs the same action; a short animation is skipped when reduced motion is requested.
- **Close book** — closes every tab in the book group.

Pinning uses Obsidian's feature-detected desktop window handle and applies to the whole pop-out, never an individual note. Closing a managed pop-out with its native window control returns its cached tabs and active view to the main workspace; an intentional **Close book** does not restore it.

## Book colors

Book colors have two mutually exclusive sources.

### Manual mode

Root Books Tabs automatically lists every first-level folder in **Settings → Root Books Tabs**. Each row has:

- an HTML color picker;
- a `#RRGGBB` text field.

A stable, dark-theme-friendly color is generated for newly discovered books until you choose another one. Manual tab text defaults to white. When **Tab color style** is **Background**, the Decorations section displays a black/white dot for each book; those controls are hidden for every other tab style.

### Frontmatter mode

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
color: "#69b7ff"
tab-text-bg: black
---
```

`tab-text-bg` accepts `black`, `white`, or any valid CSS hex color. It applies only to the Background tab style. A missing or invalid value resolves to white and is repaired the next time Root Books Tabs refreshes the book config metadata. Its property-name setting also appears only while Background is selected.

The filename is entered in settings **without `.md`**.

When a config note exists but the configured color property is missing or invalid, Root Books Tabs adds a valid color with `FileManager.processFrontMatter()`. The operation is idempotent: the property is not duplicated.

If a config note is missing, Root Books Tabs can notify you. Run **Root Books Tabs: Manage missing book config notes** to open a manager where you can:

- create the file for selected books;
- create it for all missing books;
- select **Never notify me**.

There is also a persistent toggle in settings for missing-config notifications.

## Visual book markers

### Note label

Enabled by default. A small colored book name is inserted at the top of each Markdown note view before the note content.

### Tabs

Tab coloring is enabled by default. Available styles:

- underline;
- full colored background;
- colored dot before the tab title;
- custom CSS.

The active tab uses a subtly brighter variant of the same book color.

### Book-mode explorer

Book mode is enabled by default and can be toggled from the file-explorer action bar or the command palette. It replaces the hand-selected first-level folder row with a book bar and shows that folder's contents directly beneath it. Clicking the bar changes the persistent primary selection.

Opening another book does not replace that primary tree. Each additional book with an open note/resource appears underneath in opening order as its own flattened, colored subtree and disappears when its last file is closed. If the primary book closes, the newest remaining subtree is promoted to primary. A subtree's book-name bar changes to a red **Close book** action on hover. A separate **Open another book** action lists only unopened books; Shift-clicking it opens the chosen book in a pop-out. Its hover explanation wraps inside narrow explorers, and the action disappears when every book is open. Disabling book mode restores every normal root item and removes all injected bars and ordering classes.

The secondary explorer bar explains both close modifiers on hover. Hold Shift while hovering to choose one group/window instance from a menu; hovering an entry dims and outlines the exact group that will close. Ctrl-click the bar to close every instance of that book. An ordinary click closes the canonical instance, and pseudo-tab menu actions retain their existing behavior.

The configured index note is the preferred entry page when a book is opened from the dropdown or **Open another book** menu. If it is missing, Root Books Tabs opens the shallowest Markdown file in that book, falling back to another resource, so the absence of `index.md` does not prevent the book from opening.

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

Root Books Tabs stores settings through Obsidian's `Plugin.loadData()` / `Plugin.saveData()` mechanism. The legacy plugin ID remains `scope-tabs` so existing settings and installed vault folders continue to work:

```text
.obsidian/plugins/scope-tabs/
```

The vault notes themselves are modified only when frontmatter mode is used to add/create the configured per-book color metadata.

Use **Reset to defaults** in the settings page to restore the default configuration. Detected book colors are regenerated afterward.

## Privacy and offline use

Root Books Tabs is designed for offline vault use.

- No telemetry.
- No external service.
- No network request.
- No remote code.
- No reading or writing outside the vault.

The only note-content mutation is the explicit frontmatter color-management feature described above.

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
├── colors.ts           manual/frontmatter color resolution and config creation
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
