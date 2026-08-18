# Scope Tabs

Scope Tabs was created to make it easier to browse **offline Obsidian vaults that are also published with [root-index-panels](https://github.com/VingGit/root-index-panels)**. It is intended to pair especially well with a folder-focus plugin such as [Explorer Focus](https://github.com/davidvkimball/obsidian-explorer-focus): the folder-focus plugin controls what the file explorer shows, while Scope Tabs controls where navigation opens.

In the spirit of root-index-panels, **every first-level folder in the vault is treated as a separate “book.”** That book boundary is the default scope that drives tab groups, splits/pop-out windows, book colors, and the small book label shown above notes.

If a vault does not contain at least two first-level folders, Scope Tabs does nothing to navigation.

> **Status:** `0.1.0` is the first development build. The routing core uses Obsidian workspace APIs; a few visual compatibility features necessarily touch Obsidian's DOM or tab-group internals and are isolated so they can be repaired without changing the scope/navigation model.

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

Navigating from one note to another note in the same first-level folder opens the destination in a **new tab in the same book tab group**.

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
- in a rotating right → down → left → up **spiral** pattern;
- in an external Obsidian pop-out window.

Scope Tabs tries to keep **one managed tab group per book**. If a destination book already has a managed group, navigation opens a new tab there instead of creating another group.

### Explicit user windows

Scope Tabs respects a destination leaf that Obsidian or the user explicitly created. In particular, an external pop-out window created manually from the file tree is treated as a **free window**: while working in it, navigation keeps creating tabs in that window regardless of first-level folder.

### Book controls

Managed book groups receive controls at the right edge of their tab-header area:

- **Minimize** — collapses the group to a compact header-sized strip while preserving the group and its place in the tiling layout. Navigating back into that book restores it.
- **Pop out** — reproduces the book's tabs in an external Obsidian window and removes the old in-workspace group.
- **Close book** — closes every tab in the book group.

Obsidian's public plugin API does not expose an operating-system window-minimize command. In a pop-out, the Scope Tabs **Minimize** control therefore collapses the book inside that Obsidian window; the native operating-system minimize/maximize controls remain available for minimizing the whole pop-out window.

## Book colors

Book colors have two mutually exclusive sources.

### Manual mode

Scope Tabs automatically lists every first-level folder in **Settings → Scope Tabs**. Each row has:

- an HTML color picker;
- a `#RRGGBB` text field.

A stable, dark-theme-friendly color is generated for newly discovered books until you choose another one.

### Frontmatter mode

Scope Tabs looks for a Markdown config note in every first-level folder.

Defaults:

```text
config note: index.md
property:    color
```

Example:

```yaml
---
color: "#69b7ff"
---
```

The filename is entered in settings **without `.md`**.

When a config note exists but the configured color property is missing or invalid, Scope Tabs adds a valid color with `FileManager.processFrontMatter()`. The operation is idempotent: the property is not duplicated.

If a config note is missing, Scope Tabs can notify you. Run **Scope Tabs: Manage missing book config notes** to open a manager where you can:

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

### File explorer

Only the first-level folder containing the **currently selected note** is colored. Available styles:

- subtle colored left edge;
- underline the first-level folder row;
- color the vertical edge spanning the entire folder tree;
- custom CSS.

Custom CSS can use:

```css
--scope-tabs-book-color
[data-scope-tabs-book]
```

The custom CSS text is stored with Scope Tabs settings and injected locally into Obsidian windows. No network request is made.

## Settings persistence

Scope Tabs stores settings through Obsidian's `Plugin.loadData()` / `Plugin.saveData()` mechanism. In a normal vault this results in plugin data under:

```text
.obsidian/plugins/scope-tabs/
```

The vault notes themselves are modified only when frontmatter mode is used to add/create the configured per-book color metadata.

Use **Reset to defaults** in the settings page to restore the default configuration. Detected book colors are regenerated afterward.

## Privacy and offline use

Scope Tabs is designed for offline vault use.

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

Run `npm run dev`, reload Obsidian, then enable **Scope Tabs** under **Settings → Community plugins**.

## Architecture

```text
src/
├── main.ts             plugin lifecycle and registrations
├── scope.ts            first-level-folder scope resolver
├── navigation.ts       navigation interception and book-group routing
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

Do not make routing logic depend directly on Explorer Focus, root-index-panels, or any other folder-focus plugin. Integrations can be added later as alternative scope resolvers/adapters.

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

The included GitHub Actions release workflow builds them when a version tag is pushed and creates a draft GitHub release.

## License

0BSD. See `LICENSE`.
