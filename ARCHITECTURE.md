# Scope Tabs architecture

## Design goal

Scope Tabs treats each first-level vault folder as a separate **book** and keeps navigation context grouped by that scope. The first release deliberately fixes scope depth at one while keeping scope resolution replaceable.

The plugin is organized as a pipeline:

```text
TFile
  ↓
Scope resolver
  ↓
BookScope | unscoped
  ↓
Navigation policy
  ↓
Workspace operation
  ↓
Visual decoration
```

A future scope mode should normally replace or extend the resolver rather than rewrite navigation.

## Module boundaries

### `src/scope.ts`

`FirstLevelFolderScopeResolver` owns the definition of a book.

Current rule:

- `Programming/Python/functions.md` → `Programming`
- `History/Rome.md` → `History`
- `README.md` at vault root → unscoped

The navigation controller consumes `BookScope` objects and should not parse paths itself.

### `src/navigation.ts`

Owns navigation policy and workspace placement.

Responsibilities:

- preserve Obsidian behavior for unscoped files and single-folder vaults;
- create a new tab for same-book navigation;
- reuse a managed destination-book tab group when one exists;
- create a split/pop-out group when a new book is encountered;
- preserve manually created destination leaves and free pop-out windows;
- close, pop out, restore, and minimize managed book groups;
- restore the original `WorkspaceLeaf.openFile` implementation on plugin unload.

The controller patches `WorkspaceLeaf.prototype.openFile` because reacting only after `file-open` is too late to preserve the source tab. The original method is retained exactly and plugin-generated routing calls that saved method behind a re-entry guard.

### `src/colors.ts`

Owns book color resolution and per-book Markdown config metadata.

Manual mode stores colors in plugin settings. Frontmatter mode reads the configured note/property. Existing config notes are edited with `FileManager.processFrontMatter()` and missing notes are created only after explicit user action.

### `src/decorations.ts`

Owns UI decoration and all DOM-sensitive compatibility code.

This includes:

- the small book label above Markdown note content;
- tab decoration;
- active-book file-explorer decoration;
- book-group controls;
- minimized-group presentation;
- injected user CSS.

DOM selectors and internal tab-group structure assumptions must stay here (or in a dedicated compatibility module if this file is split later). A selector failure should degrade decoration, not core routing.

### `src/settings.ts`

Owns the settings UI and missing-config modal. It should call service/controller methods rather than reproducing their logic.

### `src/main.ts`

Owns plugin lifecycle, registrations, persisted settings loading/saving, and cross-module orchestration. Keep feature algorithms out of this file.

## Managed groups versus free windows

Scope Tabs distinguishes managed book groups from explicit user navigation destinations.

A managed group is expected to contain notes from one book. Cross-book routing tries to keep one managed group per book.

If Obsidian/the user explicitly supplies another destination leaf, Scope Tabs does not redirect that operation. A manually created external pop-out is therefore a **free window**: subsequent navigation from that window stays in tabs in the same window, even when first-level folders differ.

## Public API and compatibility boundary

Prefer documented Obsidian workspace primitives for routing:

- `WorkspaceLeaf.openFile`
- `Workspace.getLeaf('tab')`
- `Workspace.createLeafBySplit`
- `Workspace.openPopoutLeaf`
- `Workspace.revealLeaf`
- `WorkspaceLeaf.getRoot`
- `FileManager.processFrontMatter`
- `Plugin.loadData()` / `Plugin.saveData()`

Some requested presentation operations do not have a complete public API. Current compatibility-sensitive areas are:

- mapping a `WorkspaceLeaf` to its tab-header DOM element;
- file-explorer root-folder DOM decoration;
- reordering a newly created tab to the left by feature-detecting tab-group child operations.

Keep those paths optional and feature-detected. A future Obsidian DOM change should not prevent note navigation.

## Single-folder invariant

Before routing, decoration, notification, or config-frontmatter maintenance, check that the vault currently contains at least two first-level folders. With zero or one book, Scope Tabs is intentionally inert.

## Persistence

Plugin settings use Obsidian's normal `loadData`/`saveData` storage under the plugin directory in `.obsidian`.

Runtime group bookkeeping is intentionally ephemeral. Book identity comes from the files in a group rather than a persisted custom workspace schema. If persistent cross-restart group identity is added later, it should be versioned separately from ordinary user settings.

## Unload

Unload must be safe and idempotent:

1. restore the exact saved `WorkspaceLeaf.prototype.openFile` implementation;
2. remove injected style elements;
3. remove plugin-created labels and book controls;
4. clear plugin data attributes/CSS variables;
5. leave user tabs, notes, and workspace layout intact.

Never treat ordinary plugin unload as an uninstall event.

## Testing matrix

At minimum test:

- single-folder inert vault;
- three books with same-book and cross-book links;
- right/left/up/down/spiral group creation;
- existing destination-book reuse;
- external managed books and manual free pop-outs;
- left/right new-tab insertion and focus toggle;
- close/pop-out/minimize controls;
- manual and frontmatter colors;
- missing config creation for selected/all books;
- duplicate-frontmatter prevention;
- tab/explorer custom CSS;
- disable/re-enable teardown;
- restart with a pre-existing workspace layout.
