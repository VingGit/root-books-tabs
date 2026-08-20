# Root Books Tabs architecture

## Design goal

Root Books Tabs treats each first-level vault folder as a separate **book** and keeps navigation context grouped by that scope. The first release deliberately fixes scope depth at one while keeping scope resolution replaceable.

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
- reuse an already-open destination file, or create a new tab for a new same-book destination;
- reuse a managed destination-book tab group when one exists;
- create a split/pop-out group when a new book is encountered;
- place main-workspace books in cardinal or configurable clockwise Grid/overflow layouts;
- preserve manually created destination leaves and free groups/windows;
- adopt Obsidian's forced empty leaf before creating a split;
- preserve a persisted logical book order with the selected primary first, append new/returning groups at the configured expansion end, and promote the latest remaining book when the primary closes;
- close and transfer managed book groups between the main workspace and pop-outs;
- accept edge-aware whole-group drag placements from the decoration controller while preserving all view states and managed/free ownership;
- explicitly regroup mixed and separated scoped tabs by book while preserving view states and active focus;
- cache managed pop-out view states so native window closure can return them to the main workspace;
- restore versioned managed/free group ownership from feature-detected group IDs;
- restore the original `WorkspaceLeaf.openFile` implementation on plugin unload.

The controller patches `WorkspaceLeaf.prototype.openFile` because reacting only after `file-open` is too late to preserve the source tab. The original method is retained exactly and plugin-generated routing calls that saved method behind a re-entry guard.

### `src/colors.ts`

Owns book color resolution and per-book Markdown config metadata.

Manual mode stores book backgrounds plus an optional black/white Background-style tab foreground in plugin settings. Its default is always white, and its per-book controls live beside the Background tab-style setting rather than the book-color inputs. Frontmatter mode reads independently configured background and tab-text properties; the text value accepts `black`, `white`, or any CSS hex color and falls back to white. Both foreground sources apply only to Background tabs. Existing config notes are edited with `FileManager.processFrontMatter()` and missing notes are created only after explicit user action.

### `src/decorations.ts`

Owns UI decoration and all DOM-sensitive compatibility code.

This includes:

- the small book label above Markdown note content;
- tab decoration;
- integrated book-mode filtering, action toggle, and book switcher;
- the book-icon pseudo-tab, its group menu, long-press regroup action, and the cross-window group-drag/drop adapter;
- injected user CSS.

DOM selectors and internal tab-group structure assumptions must stay here (or in a dedicated compatibility module if this file is split later). A selector failure should degrade decoration, not core routing.

### `src/settings.ts`

Owns the stable settings UI, custom-tab-CSS preview modal, and missing-config modal. Conditional sections are mounted once so ordinary changes do not reset settings scroll position.

### `src/leaf-file.ts` and `src/new-note.ts`

`leaf-file.ts` resolves a `TFile` from any file-backed leaf, using public `FileView.file` first and view-state fallback for deferred/resource views. `new-note.ts` ownership-safely wraps the app's public `FileManager.getNewFileParent()` instance method. It also feature-detects the internal `createNewFolder(null)` toolbar path because Obsidian exposes no public folder-parent hook. Both wrappers restore only when Root Books Tabs still owns them.

### `src/main.ts`

Owns plugin lifecycle, registrations, persisted settings loading/saving, and cross-module orchestration. Keep feature algorithms out of this file.

## Managed groups versus free windows

Root Books Tabs distinguishes managed book groups from explicit user navigation destinations.

A managed group contains pages/resources from one book. Cross-book routing keeps one canonical managed group per book, either in the main workspace or a pop-out.

If Obsidian/the user explicitly supplies another destination leaf, Root Books Tabs does not redirect that operation. The destination group is a **free exception**: subsequent navigation stays in that group even when first-level folders differ.

A homogeneous free group still receives book controls. Transfers preserve whether the source was canonical-managed or free, so moving a duplicate instance cannot steal canonical ownership. Pop-out detection combines the workspace root type with the leaf document because Obsidian windows may cross JavaScript realms.

## Public API and compatibility boundary

Prefer documented Obsidian workspace primitives for routing:

- `WorkspaceLeaf.openFile`
- `Workspace.getLeaf('tab')`
- `Workspace.createLeafBySplit`
- `Workspace.openPopoutLeaf`
- `Workspace.setActiveLeaf`
- `WorkspaceLeaf.getViewState` / `WorkspaceLeaf.setViewState`
- `WorkspaceLeaf.getRoot`
- `FileManager.processFrontMatter`
- `Plugin.loadData()` / `Plugin.saveData()`

Some requested presentation operations do not have a complete public API. Current compatibility-sensitive areas are:

- mapping a `WorkspaceLeaf` to its tab-header DOM element;
- file-explorer root-item filtering, expansion, and action-bar/book-bar injection;
- inserting a decoration-only book pseudo-tab before real tab headers;
- interpreting drag/drop on that pseudo-tab as a view-state-preserving whole-group transfer with feature-detected workspace group DOM targets;
- the optional desktop `window.electronWindow` adapter used only for pop-out always-on-top pinning;
- reordering a newly created tab to the left by feature-detecting tab-group child operations.
- wrapping a Grid overflow base cell in a nested split so overflow halves that cell instead of flattening into its surrounding row/column; the adapter mirrors the feature-detected `WorkspaceSplit` operations in the locally installed Obsidian build and then delegates creation to public `createLeafBySplit`.

Book pop-out transfer copies public view states so non-Markdown tabs are preserved when possible. The original group is detached only after every replacement tab has been created successfully.

Keep those paths optional and feature-detected. A future Obsidian DOM change should not prevent note navigation.

## Single-folder invariant

Before routing, decoration, notification, or config-frontmatter maintenance, check that the vault currently contains at least two first-level folders. With zero or one book, Root Books Tabs is intentionally inert.

## Persistence

Plugin settings use Obsidian's normal `loadData`/`saveData` storage under the plugin directory in `.obsidian`.

Runtime group ownership, logical book order, and up to 256 stable Grid base-book IDs are stored under `runtimeStateV1`, separately from the additive flat settings migration. Legacy 4x4 fields migrate into the generic Grid fields. Feature-detected Obsidian group IDs recover managed pop-outs and explicit free groups after restart; routing still works when an ID is unavailable.

## Unload

Unload must be safe and idempotent:

1. restore the exact saved `WorkspaceLeaf.prototype.openFile` implementation;
2. restore the app-instance note-parent and optional folder-creation methods only when Root Books Tabs still owns each patch;
3. disconnect explorer observers and remove injected toggles, bars, labels, pseudo-tabs, and styles;
4. restore hidden explorer items and clear plugin classes, data attributes, and CSS variables;
5. leave user tabs, notes, and workspace layout intact.

Never treat ordinary plugin unload as an uninstall event.

## Testing matrix

At minimum test:

- single-folder inert vault;
- three books with same-book and cross-book links;
- root-level files after navigating away from a decorated book note;
- right/left/up/down group creation and 2–16-row/column Grid base/overflow placement in every overflow direction;
- existing destination file/tab and destination-book reuse;
- external managed books and manual free pop-outs;
- empty-leaf adoption and selected-book-root creation with no open files;
- toolbar folder creation in current-folder/book-root modes;
- left/right new-tab insertion and focus toggle;
- close/pop-out transfer controls, whole-pop-out pinning, pseudo-tab group dragging within/between main and pop-out windows, and menu/long-press tab regrouping;
- pop-out focus, pin/unpin, native-close return, and intentional-close suppression;
- pop-out transfer of mixed Markdown and non-Markdown tabs;
- manual and frontmatter colors, white manual foreground defaults, Background-only black/white overrides, and custom frontmatter tab-text colors;
- missing config creation for selected/all books;
- duplicate-frontmatter prevention;
- resource routing/color for PNG, SVG, PDF, Canvas, and Bases;
- book-mode primary-tree persistence plus temporary open-book subtrees and full cleanup;
- missing-index entry fallback, latest-secondary promotion, selected-first order, and narrow explorer hover wrapping;
- duplicate homogeneous group controls, Shift-hover instance selection/dimming, Ctrl-click close-all, and cross-realm pop-out detection;
- custom tab CSS modal at narrow and wide sizes;
- disable/re-enable teardown;
- restart with a pre-existing workspace layout.
