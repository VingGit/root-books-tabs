# Changelog

## 0.9.0

- Replaced the archived Root Books Tabs implementation with Root Books
  Workspace and a new `root-books-workspace` plugin ID.
- Added explicit setup and isolated audits for Folder Notes, Custom File
  Explorer Sorting, Front Matter Title, and Frontmatter Date Manager.
- Added portable `panel.icon` and direct-hex `panel.accent` book metadata,
  appearance editing, passive tab decoration, and a current-book status item.
- Added folder-note title synchronization, inherited note templates and date
  prefixes, filename-derived creation dates, and selective ordering refreshes.
- Added a replacement unique-note command and ribbon action. The core Unique
  Note Creator is disabled only when the user accepts the recommended setup.
- Kept workspace routing, managed groups, grids, pop-outs, focused Explorer
  views, Article Navigator, bulk frontmatter tools, and the legacy sorting and
  `book-tabs` configuration outside this first release.
