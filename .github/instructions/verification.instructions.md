---
name: Verification
description: Required automated and manual checks
applyTo: "{src,tests,scripts}/**,package.json,manifest.json,styles.css"
---

# Verification

Before pushing a source change, run:

```text
npm ci
npm run format
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

Manually test onboarding with all companions present, each companion missing,
and recommended settings drifting. Test plugin disable/re-enable, new notes,
unique notes, folder renames, filename-date renames, template application,
Custom Sort refresh coalescing, appearance editing, and legacy conversion in a
disposable vault. Confirm the core Unique Note Creator is disabled only after
the user accepts the recommended setup.
