# @xeplr/workflow-api — map

The HTTP layer over `@xeplr/workflow-engine`: Express routers for workflows, runs, triggers, the
flows (screens) facade and the tasks inbox, plus a standalone server. Embedded by BI and by apps
made with `@xeplr/cli`. All behaviour lives in the engine — this package holds routes, the auth
catalog (`migrations-auth/`) and standalone wiring, nothing else.

## Where things are
- `index.js` — `registerWorkflow(config)`: `engine.startEngine(config)` → build routers → mount on `config.app`, or create an app (`config.port`), or return `{router, flowsRouter}` to mount yourself; re-exports `resumeByKey`, `embedRequiredEnv`, `callbackRequiredEnv`
- `lib/router.js` — `buildWorkflowRouter(config)`: `/`, `/me`, `/actions`, `/companies` (ungated, Company is not multi-tenant), `/workspaces`, `/workflows` (generic CRUD + `by-key/:key`, `by-trigger`, `:id/runs`, `:id/trigger`, `:id/run`, `save` guarded by `refuseScreensEdit()`), `/runs/:runId` (+ `cancel`, `retry` via `adminRoute`), `/triggers`, step sample output (`:id/steps/:stepKey/last-output`, `steps/preview`, `steps/try`), email templates (from `@xeplr/email` when ready), `POST /public/resume/:key`
- `lib/flowsRouter.js` — `buildFlowsRouter(config)`: `/flows` list/create/get/put/publish, `/:key/runs`, `/runs/:runId`, `/runs/:runId/submit`, `/waiting`; `requireApi(name)` when `config.access`; `API_NAMES`; `handle()` maps engine errors to status
- `lib/tasksRouter.js` — `buildTasksRouter(config)`: `/tasks/mine`, `/:id/claim|release|answer|reassign`; `API_NAMES`
- `orchestration/standalone.js` — the standalone boot: env check, `registerApplication`, migrations, `xeplr_configs`, email templates, auth, `jobs.init({migrate:true, onFinish: engine.jobFinished})` with `engine.jobActions` registered, `registerWorkflow({startJob, keepSchedule: jobs.keepSchedule, mountPath:'/'})`, `jobs.startScheduler()`
- `bin/www` — requires `orchestration/standalone`
- `env.required.js` — STANDALONE env list (spreads auth, email, actions, jobs lists + `DB_API`, `WORKFLOW_PORT`, `AUTH_SUPER_ADMIN_PASSWORD`); embedded hosts use `embedRequiredEnv` instead
- `migrations-auth/` — `apis`/`menus` rows and role mappings for every route (applied by the auth server)

## Flow
- Embedded host: `registerWorkflow({ db:{name, connection}, mtMembershipGate, startJob, keepSchedule, resolveConnection, onTask })` → engine boots → `router` mounted under the host's path.
- Request: `gate` (`mtMembershipGate`, noop when omitted) → route → engine function (`engine.flows.*`, `engine.runner.*`, `engine.tasks.*`, `engine.triggers.*`) → `respond`.
- Save of a scheduled workflow → generic CRUD → engine's `models/Workflow.js` hook → `keepSchedule` (the host's `@xeplr/jobs`).

## To change X, edit Y
- A new workflow/run route → `lib/router.js` + a `migrations-auth/00NN_*.sql` row (group + role mappings) in the same change
- A new flows route → `lib/flowsRouter.js` (+ `API_NAMES` entry) + `migrations-auth/`
- A new tasks route → `lib/tasksRouter.js` (+ `API_NAMES`) + `migrations-auth/`
- What a route does → the engine (`@xeplr/workflow-engine/lib/*`), not here
- Standalone boot order / jobs wiring → `orchestration/standalone.js` → `start()`
- Standalone env → `env.required.js`; embedded env → engine `index.js` `embedRequiredEnv`
- Error → HTTP status mapping for flows → `lib/flowsRouter.js` → `sendError()`

## Rules and traps
- Routers never read `process.env` for config (only `exposedEnv()` per request in try-run), so embedded and standalone behave the same.
- `createApp` adds a catch-all 404 after its routes: a host built on `createApp` must pass the router in its route map (third mode), not `app.use()` it afterwards.
- Omitting `mtMembershipGate` leaves every route ungated — dev only.
- `config.access: true` makes flows/tasks routes check `req.access.apis` by name and fail closed with no `req.access` (`requireApi`). API names in `API_NAMES` must match the `migrations-auth` rows exactly.
- Schedules only work when `keepSchedule` is passed (see engine map); standalone passes `jobs.keepSchedule` and starts the scheduler itself.
- Workflow's DB is its own (`xeplr_bi_workflow`); never shared between hosts. `registerApplication()` must have run before `registerWorkflow` (engine throws).
- `POST /public/resume/:key` is the only public route (standalone `auth.publicPaths` lists `/public/`, `/events`).

## Test
- `npm install && npm test` (`node test/run.mjs`, each `*.test.mjs` in its own process).
- Real-Postgres suites (`flows`, `triggersRoutes`, `tasksRoutes`, `runProgress`, `stepPreview`, `authMigrations`) need `WORKFLOW_TEST_PG='{"host":"localhost","port":5432,"user":"vikasbhandari","password":""}'`; skipped otherwise.
- `authMigrations.test.mjs` fails when a route row has no role besides Super Admin; `flowsAccess.test.mjs` covers `access: true`; `requires.test.mjs` checks relative requires. Per-suite detail: see README → Tests.
