# Scope Tabs

Scope Tabs was created to make it easier to browse **offline Obsidian vaults that are also published with [root-index-panels](https://github.com/VingGit/root-index-panels)**. It is intended to pair especially well with a folder-focus plugin such as [Explorer Focus](https://github.com/davidvkimball/obsidian-explorer-focus): the folder-focus plugin controls what the file explorer shows, while Scope Tabs controls where navigation opens.

In the spirit of root-index-panels, **every first-level folder in the vault is treated as a separate “book.”** That book boundary is the default scope that drives tab groups, splits/pop-out windows, book colors, and the small book label shown above notes.

If a vault does not contain at least two first-level folders, Scope Tabs does nothing to navigation or decoration.

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

Settings control whether the new tab is inserted to the **right** or **left**, and whether it receives focus automatically.

### Different book

Navigating to a note whose first-level folder differs from the current note opens/reuses that book's tab group and focuses it.

A new book can be opened right, left, above, below, in a rotating right → down → left → up **spiral** pattern, or in an external Obsidian pop-out window.

Scope Tabs tries to keep **one managed tab group per book**. If a destination book already has a managed group, navigation opens a new tab there instead of creating another group.

### Explicit user windows

Scope Tabs respects a destination leaf that Obsidian or the user explicitly created. In particular, an external pop-out window created manually from the file tree is treated as a **free window**: while working in it, navigation keeps creating tabs in that window regardless of first-level folder.

### Book controls

Managed book groups receive controls at the right edge of their tab-header area:

- **Minimize** — collapses the group to a compact header-sized strip while preserving the group and its place in the tiling layout. Navigating back into that book restores it.
- **Pop out** — reproduces the book's tabs in an external Obsidian window and removes the old in-workspace group.
- **Close book** — closes every tab in the book group.

External pop-out windows remain ordinary operating-system windows, so normal OS window minimize/maximize controls continue to apply.

## Book colors

Book colors have two mutually exclusive sources.

### Manual mode

Scope Tabs automatically lists every first-level folder in **Settings → Scope Tabs**. Each row has an HTML color picker and a `#RRGGBB` text field. A stable, dark-theme-friendly color is generated for newly discovered books until you choose another one.

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

If a config note is missing, Scope Tabs can notify you. Run **Scope Tabs: Manage missing book config notes** to create the file for selected books, create it for all missing books, or select **Never notify me**.

## Visual book markers

The note label is enabled by default and shows a small colored book name before note content.

Tab coloring is enabled by default. Available styles are underline, full colored background, colored dot before the title, or custom CSS. The active tab uses a subtly brighter variant of the same book color.

File explorer coloring applies only to the first-level folder containing the **currently selected note**. Styles are left edge, folder underline, full folder vertical bar, or custom CSS.

Custom CSS can use:

```css
--scope-tabs-book-color
[data-scope-tabs-book]
```

## Settings persistence

Scope Tabs stores settings through Obsidian's `Plugin.loadData()` / `Plugin.saveData()` mechanism, normally under:

```text
.obsidian/plugins/scope-tabs/
```

The vault notes themselves are modified only when frontmatter mode is used to add/create configured per-book color metadata. Use **Reset to defaults** to restore default settings.

## Privacy and offline use

Scope Tabs is designed for offline vault use: no telemetry, external services, network requests, remote code, or filesystem access outside the vault.

## Development

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run build
npm run lint
```

For local testing, place/clone the repository at `<Vault>/.obsidian/plugins/scope-tabs/`, run `npm run dev`, reload Obsidian, then enable **Scope Tabs** under **Settings → Community plugins**.

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

The design boundary is `scope resolution → routing decision → workspace operation → decoration`. Do not make routing depend directly on Explorer Focus, root-index-panels, or another folder-focus plugin; future integrations belong behind scope resolvers/adapters.

## Compatibility boundary

Obsidian exposes core leaf, split, tab, and pop-out primitives, but not every visual tab-header/file-explorer operation as a stable public API. Left-side tab insertion therefore uses a feature-detected compatibility path, while tab-header and explorer decoration depend on Obsidian DOM class names. Those pieces are isolated from core scope/routing logic.

## Release files

An Obsidian release attaches `main.js`, `manifest.json`, and `styles.css`. The included tag-triggered GitHub Actions workflow builds them and creates a draft release.

## License

0BSD. See `LICENSE`.
