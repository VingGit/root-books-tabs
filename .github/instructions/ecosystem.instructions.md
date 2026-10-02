---
name: Root Books ecosystem
description: Lockstep versioning and sibling repository compatibility
applyTo: "**"
---

# Root Books ecosystem

This project releases in lockstep with:

- `VingGit/root-index-panels`
- `VingGit/custom-file-explorer-sorting-support`

All three packages use the same semantic version. Any change to one project
requires a compatibility audit of the other two, synchronized instructions and
human documentation where affected, and a coordinated version bump/release.
Use release tags that exactly equal the version without a leading `v`.

No instruction or fixture may contain a contributor's machine-specific path,
vault contents, account data, or credentials.
