---
name: Seed must include all demo users with explicit password hashes
description: student1 was missing from seed causing login failures after server restart
---

The seed.ts file must have explicit INSERT + ON CONFLICT DO UPDATE for every demo user. Using ON CONFLICT DO NOTHING means password changes don't propagate; using only an UPDATE won't create the user if it doesn't exist.

Hashes in seed.ts (bcryptjs rounds=10):
- A_HASH → admin/admin123
- T_HASH → teacher1/teacher123
- S_HASH → student1/student123

**Why:** The server restarts on every deploy/dev restart and re-runs seed(). If a user was created in a previous session with a different hash (or not at all), subsequent logins fail with "wrong password". ON CONFLICT DO UPDATE ensures the canonical test password is always set.
