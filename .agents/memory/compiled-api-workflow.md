---
name: Compiled API workflow
description: Runtime refresh requirement for the API workflow in this monorepo.
---

The API development workflow builds the server bundle and then starts Node from the generated output. Source edits to routes or services are not guaranteed to be reflected by the already-running process; the workflow must be restarted before browser/API verification.

**Why:** A browser test initially exercised the old endpoint bundle after a read-contract source edit, making valid persisted provenance appear missing until the API was rebuilt and restarted.

**How to apply:** Restart the API workflow after backend source, package, migration, or run-command changes. Confirm the fresh logs show a successful build and `Server listening` before diagnosing endpoint behavior.