# myaiteacher — Քո անձնական AI ուսուցիչը

A full-stack Armenian-language AI tutoring platform ("Karhanyan School | myaiteacher") where students track lessons, view subject progress, and see their learning statistics.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/myaiteacher run dev` — run the React frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string; `SESSION_SECRET` — JWT signing secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: JWT (jsonwebtoken + bcryptjs)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite + Tailwind CSS + shadcn/ui components
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/users.ts` — users table (id, username, password_hash, full_name, created_at)
- `lib/db/src/schema/student-progress.ts` — student_progress table (id, user_id, subject, lesson, score, status, created_at)
- `artifacts/api-server/src/routes/auth.ts` — register, login, profile endpoints
- `artifacts/api-server/src/routes/dashboard.ts` — dashboard stats, progress, recent activity
- `artifacts/api-server/src/middlewares/auth.ts` — JWT requireAuth middleware + signToken helper
- `artifacts/myaiteacher/src/lib/auth.tsx` — AuthContext, AuthProvider, useAuth hook
- `artifacts/myaiteacher/src/pages/` — index (landing), login, register, dashboard pages

## Architecture decisions

- JWT stored in `localStorage` under key `myaiteacher_token`; `setAuthTokenGetter` from the custom fetch library injects the Bearer token on every API call.
- bcryptjs (pure JS) chosen over bcrypt for native-build compatibility in this environment.
- All UI text is in Armenian; color palette is exact per spec: `#0F172A` bg, `#6366F1` indigo, `#14B8A6` teal, `#F59E0B` amber.
- Dashboard aggregates are computed server-side from the `student_progress` rows (no separate aggregation table).

## Product

- **Landing page** — Armenian hero section with 4-step flow and login/register buttons
- **Register / Login** — JWT-based auth, token stored in localStorage
- **Student Dashboard** — stats (completed lessons, average score, pending homework), overall progress bar, per-subject progress bars, recent activity feed

## Seed data

- Default user: `student1` / `student123` (full name: Արամ Կարապետյան)
- 11 pre-seeded progress rows across 5 subjects: Մաթեմատիկա, Հայոց լեզու, Ֆիզիկա, Պատմություն, Անգլերեն

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm run typecheck:libs` after changing any `lib/*` schema before typechecking artifact packages — stale lib declarations cause "has no exported member" errors.
- After every `openapi.yaml` change, re-run `pnpm --filter @workspace/api-spec run codegen`.
- bcrypt is blocked (native build scripts not allowed); use bcryptjs instead.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
