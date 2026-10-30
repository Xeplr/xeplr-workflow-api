# @xeplr/workflow-api

**The workflow HTTP API.** The routes the workflow builder and the flows screens talk to, over [`@xeplr/workflow-engine`](https://github.com/Xeplr/xeplr-workflow-engine), which holds the tables and runs the workflows. A workflow is a sequence of steps: each step names an action registered in `@xeplr/actions`, binds its inputs to what earlier steps produced, and routes to the next, branching on conditions, fanning out over lists, and waiting for a person or a job before it carries on. The screens are yours: build them on these routes, or use X-Flow's.

**Free and open source (MIT, [LICENSE](LICENSE))**, on npm as `@xeplr/workflow-api` and on GitHub at [Xeplr/xeplr-workflow-api](https://github.com/Xeplr/xeplr-workflow-api). With the engine it is a complete base: an app (asset management, an ERP, anything) mounts these routes and builds its **own** workflow screens on them. **X-Flow**, Xeplr's premium workflow product, is built on the same two packages and adds the visual designer (steps drawn and connected on a canvas) and data operations between steps; neither is part of this package.

It runs two ways: **embedded**, where a host calls `registerWorkflow()` and mounts the returned router (Xeplr BI does this at `/workflow`, with its own auth and its own `DB_WORKFLOW` database), or **standalone** via `npm run start-api` / the `xeplr-workflow-server` command, which is the same `registerWorkflow()` call with its settings read from `development.env`.

| what | how |
|---|---|
| A step is an action | Each step names an action registered in `@xeplr/actions`; its form comes from that action's own input schema (`GET /actions`), not a second description of it. Inputs bind to earlier steps' output, the run's parameters, or a setting on an allowlist. |
| Branch, fan out, join | Conditions are compiled with the same `@xeplr/expression-handler` the engine runs, with `and` / `or` and functions. An *each* transition starts one child run per item, and a join step picks the parent back up once every child has finished. |
| Wait for a person or a job | A wait step parks the run and issues a single-use resume link — followed from an email or called back by a job — that cannot be claimed until the step is actually waiting. |
| Screens as steps (flows) | An app's forms, one after another, with arrows that test one field — the `/flows` routes (`lib/flowsRouter.js`) over the engine's flows facade. |
| Triggers | What starts a workflow — manual, api, a schedule, a job finishing — saved on the workflow itself and listed by `/triggers`, `/workflows/by-trigger` and `/workflows/:id/trigger`. A job is also a step (`job-run`). Over the engine's `triggers`. |
| Parameters checked first | A run's parameters are the union of what every step declares, validated before the run is recorded. |

What it does not do yet: a step's timeout is saved but not enforced; a draft workflow can still be run; past runs are recorded but there is no screen to browse them.

## Install

```bash
npm install @xeplr/workflow-api      # brings @xeplr/workflow-engine with it
```

The shared `@xeplr/*` libraries and `express` are **peer dependencies**: the host's copies are the ones used, so there is one `@xeplr/db` and one tenant context. If you link a local checkout of either package into a host instead (`npm link`, `file:`), run the host with `node --preserve-symlinks`, or the linked package resolves its own copy of `@xeplr/db` and a request's company is set in one and read from the other.

## Run it

### Standalone

```bash
npm install
npm run check-env      # fails naming any missing required var
npm run db:create      # creates the DB_API database
npm run start-api      # NODE_ENV=development node ./bin/www — listens on WORKFLOW_PORT
```

`start-api` runs the engine's migrations on boot, so `migrate:up` is only
needed to migrate without starting the server.

| Script | What it does |
|---|---|
| `start-api` | `NODE_ENV=development node ./bin/www` → `orchestration/standalone.js` |
| `check-env` | `xeplr-check-env` against `development.env` |
| `db:create` | `xeplr-migrate create-db` for connection `api` (`WORKFLOW_CONNECTION`) |
| `migrate:up` / `migrate:status` | `xeplr-migrate` over the engine's `migrations/` |
| `db:encrypt` | `xeplr-db-encrypt` — produce an encrypted connection string |
| `test` | `node test/run.mjs` |

Port in `development.env`: **19122** (`WORKFLOW_PORT`). No port literal exists
in code; a missing `WORKFLOW_PORT` stops the process at `checkEnv`.

Required services for standalone:

| Service | Why |
|---|---|
| PostgreSQL | `DB_API` (this package's tables), `XCFG_DB_NAME` (shared `xeplr_configs`), `EMAIL_DB_NAME` (template store) |
| An `@xeplr/auth` server + its database | `@xeplr/auth` `attach()` reads users/tenant grants from `AUTH_DB_NAME`; the createApp gate validates tokens against `AUTH_URL`. This package has **no** `start-auth` script — the auth server is run separately (`xeplr-auth-server`), and it applies `migrations-auth/` via `XEPLR_AUTH_MIGRATIONS` |

Boot order (`orchestration/standalone.js`): load `<NODE_ENV>.env` → `checkEnv`
→ `registerApplication(WORKFLOW_APPLICATION_ID || 'xeplr-workflow')` → run
migrations → `xeplr_configs` ready (**fail-fast**) → register action catalog →
`@xeplr/auth` attach + email config → email templates (**best-effort**) →
`registerWorkflow({ port, mountPath: '/', auth: { publicPaths: ['/public/', '/events'] }, ... })`.

### Embedded (how Xeplr BI does it)

```js
// host env.required.js
...require('@xeplr/workflow-api').embedRequiredEnv,   // ['DB_WORKFLOW']

// host startup, after the host's own registerApplication() and registerMTs()
var { registerWorkflow } = require('@xeplr/workflow-api');
var { router } = await registerWorkflow({
  db: { name: process.env.DB_WORKFLOW, connection: hostConnection, connectionName: 'workflow' },
  mtMembershipGate: hostGate,
  authMiddleware: require('@xeplr/auth').authMiddleware
});
routes['/workflow'] = router;   // into createApp's route map, not app.use() afterwards
```

Embedded, `registerWorkflow` creates the database if missing, runs this
package's migrations (plus `XEPLR_WORKFLOW_MIGRATIONS` or `config.migrations`),
tries `xeplr_configs` (warns and continues on failure), registers the action
catalog, and returns the router.

### Embedded in the host's own database

Workflow does not need a database of its own. An app can keep everything in
one:

```js
var { flowsRouter } = await registerWorkflow({
  applicationId: 'myapp1',
  db: { name: process.env.DB_API, connection: appConnection, migrationsTable: 'workflow_migrations' },
  tenantTables: false,        // the app's tenants are the tenants — see below
  access: true,               // each flows route checks the caller's permissions
  mtMembershipGate: appMemberGate
});
routes['/api/flows'] = flowsRouter;
```

| option | why |
|---|---|
| `db.migrationsTable` | Workflow's own record of which migrations ran. Both it and the host use `@xeplr/db`'s migrator, and one shared ledger would mix the two histories by filename. |
| `tenantTables: false` | `companies` and `workspaces` are **standalone** workflow's own tenant lists — the lists behind its "pick a company, then a workspace" screens (`migrations-tenants/`). Nothing in a workflow, step or run references them; runs carry `mtId1` / `mtId2` as plain ids. Embedded, the host's tenancy is used instead — its levels, its tables, its picker — or none at all. Leaving them out is also what lets workflow live in a database that already has a `companies` table. |
| `access: true` | The flows routes answer only a caller whose permissions (`req.access.apis`) name them — `List flows`, `Start flow run`… (`migrations-auth/0004_flows_access.sql`), the same way `@xeplr/factory` checks its routes. Off by default, as before. |

**Tenancy follows the host.** Embedded, workflow registers no tenancy levels of
its own; its tables are filtered by whatever the host registered with
`@xeplr/db`'s `registerMTs` — none, one level, or several. Only standalone mode
declares company → workspace (`orchestration/standalone.js`).

### Environment

Names and meaning only. Values live in `development.env` — copy
`development.env.example`, which has every name and no values. It is
git-ignored (`.gitignore`) because it carries secrets. Never commit it.

**Standalone — `env.required.js` (checked at boot):**

| Variable | Meaning | Comes from |
|---|---|---|
| `AUTH_URL` | Auth server the createApp gate validates tokens against — and, with `@xeplr/base-apis` 3, asks whether the caller belongs to the company and workspace a request names (needs `@xeplr/auth` 1.4 or later) | `@xeplr/base-apis` `gateRequiredEnv` (peer `^2.0.6 \|\| ^3.0.0`) |
| `ENCRYPTION_KEY`, `AUTH_JWT_SECRET`, `AUTH_PORT`, `AUTH_DB_NAME`, `XEPLR_AUTH_MIGRATIONS` | Decrypts stored connection strings; auth DB and token settings | `@xeplr/auth` `requiredEnv` (the inline comment in `env.required.js` lists older names) |
| `EMAIL_PROVIDER`, `BREVO_*` | Outbound mail provider | `@xeplr/email` `requiredEnv` |
| `EMAIL_DB_NAME` | This app's own email template store | `@xeplr/email` `templatesRequiredEnv` |
| `XEPLR_DATA_DIR` | The root of all data, absolute and existing. A step's files are in the run's tenant folder under it, `<root>/<app>/<company>/<workspace>/`; temporary ones in its `tmp/` | `@xeplr/actions` `requiredEnv` |
| `XCFG_DB_NAME`, `XCFG_DB_CONNECTION_INFO_ENCRYPTED` | Shared `xeplr_configs` control-plane DB | `@xeplr/actions` `configRequiredEnv` |
| `DB_API` | This package's database name | app |
| `WORKFLOW_PORT` | API port | app |
| `AUTH_SUPER_ADMIN_PASSWORD` | First account's password, consumed by auth's super-admin migration | app |

**Read but not in the required list:**

| Variable | Meaning |
|---|---|
| `WORKFLOW_CONNECTION` | Override for the server login. Normally the shared `XEPLR_DB_CONNECTION` is used; `resolveDbConnection` names both if neither is set |
| `XEPLR_DB_CONNECTION` | Shared server login every xeplr service reads |
| `WORKFLOW_APPLICATION_ID` | Application id for rows written to `xeplr_configs`; defaults to `xeplr-workflow` standalone |
| `LOG_DIR` | Log directory; `./logs` if unset |
| `NODE_ENV` | Selects `<NODE_ENV>.env` |
| `WORKFLOW_ENV_EXPOSED` | Comma-separated **exact** env var names step templates may read as `{env.NAME}`. Empty = nothing readable |
| `WORKFLOW_PUBLIC_URL` | Base URL callers reach this service on, mount path included. Builds `{resumeUrl}`. Exported as `callbackRequiredEnv`; only needed for steps that call out (today `job-run`) |
| `JOBS_API_URL` | Where the server reaches the jobs API; the jobs canvas binds `job-run.jobsUrl` to `{env.JOBS_API_URL}`, so it must also be named in `WORKFLOW_ENV_EXPOSED` |
| `XEPLR_WORKFLOW_MIGRATIONS` | Extra migration directories a host adds to workflow's database |
| `AUTH_DB_CONNECTION_INFO_ENCRYPTED`, `AUTH_ACTIVATION_BASE_URL` (or `AUTH_ACTIVATION_URL`), `AUTH_ACCESS_TOKEN_TTL_MINUTES`, `AUTH_ACCESS_TOKEN_TOLERANCE_SECONDS`, `AUTH_SUPER_ADMIN_EMAIL` | Read by `@xeplr/auth` / `xeplr-auth-server` |
| `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`, `EMAIL_TEST_TO` | Read by `@xeplr/email` |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | Redis (commented in `development.env`: defaults `localhost:6379`) |

**Embedded — `embedRequiredEnv`:** `DB_WORKFLOW` only. The host passes the
database name and connection into `registerWorkflow({ db })`; this package
never reads either variable itself.

## Structure

```
api/
├─ index.js                 registerWorkflow; passes the engine's resumeByKey and env lists through
├─ bin/www                  process entry → orchestration/standalone.js
├─ orchestration/
│  └─ standalone.js         the ONLY file that reads env for config
├─ env.required.js          standalone required-env list
├─ lib/
│  ├─ router.js             buildWorkflowRouter(config) — all HTTP routes
│  ├─ flowsRouter.js        the /flows routes
│  ├─ tasksRouter.js        the /tasks routes: the inbox, claim, answer, reassign
├─ migrations-auth/         rows for the AUTH database (roles, menus, apis)
└─ test/                    run.mjs + *.test.mjs
```

The engine (runner, flows facade, action catalog, models, workflow's own migrations) is [`@xeplr/workflow-engine`](https://github.com/Xeplr/xeplr-workflow-engine).

## API

### Exports (`index.js`)

| Export | Purpose |
|---|---|
| `registerWorkflow(config)` | The engine's `startEngine(config)` (connect, create the DB if missing, migrate, register actions), then build the router. Returns `{ router }` (no `app`, no `port`), `{ router, app }` (with `config.app`, mounted at `mountPath`, default `/workflow`), or `{ router, app, server }` (with `config.port`, via `@xeplr/base-apis` `createApp`). `config.db` is always required. Throws if no application id is registered |
| `resumeByKey(key, output?, opts?)` | The engine's, passed through. Server-side, in-process resume of a run parked on a `wait` step. `opts.status: 'failed'` resolves the step as failed. Throws `err.code` `RESUME_KEY_INVALID` (used/unknown — normal for host routes) or `RESUME_KEY_NOT_READY` (step still running; nothing consumed, retry). Requires `registerWorkflow()` to have run in the process |
| `embedRequiredEnv` | `['DB_WORKFLOW']` — spread into a host's `env.required.js` |
| `callbackRequiredEnv` | `['WORKFLOW_PUBLIC_URL']` — only for hosts using steps that call out |

`registerWorkflow` config: `app`, `db` (`{ name, connection, connectionName?, mts? }`),
`applicationId`, `mountPath`, `port`, `appName` (default `xeplr_workflow_api`),
`mtMembershipGate`, `authMiddleware`, `middleware`, `log`, `auth`, `migrations`.
Pass `db.mts` only when nothing else in the process has called `registerMTs()`
(it is process-global).

### Routes (`lib/router.js`)

Paths are relative to the mount (`/` standalone, `/workflow` in xeplr-bi).
"Gated" = `config.mtMembershipGate` (a no-op if not supplied).

| Method | Path | Gated | Purpose |
|---|---|---|---|
| GET | `/` | no | Health: `{ service, status, name }` |
| GET | `/me` | via `authMiddleware` | Current user; only mounted when `authMiddleware` is passed |
| GET | `/actions` | yes | Action catalog: `name`, `description`, `inputSchema`, `outputSchema` (never the executor) |
| GET | `/companies`, `/companies/:id` | **no** | Company `genericRoute` (Company is `multiTenant = false`) |
| POST | `/companies/save`, `/companies/delete` | **no** | " |
| GET | `/workspaces`, `/workspaces/:id` | yes | Workspace `genericRoute` |
| POST | `/workspaces/save`, `/workspaces/delete` | yes | " |
| GET | `/workflows`, `/workflows/:id` | yes | Workflow list/get with `steps` eager-loaded |
| POST | `/workflows/save` | yes | Save a workflow and its whole step list in one transaction (changeset). A `trigger` that could never fire is refused with 400 `TRIGGER_INVALID` and the reason; an arrow may be written as `when` (`{ field, op, value }`, see the engine README) and a bad one is refused with 400 `CONDITION_INVALID` naming the step and arrow |
| GET | `/workflows/:id/runs` | yes | A workflow's runs, newest first (`?limit=`, default 50, at most 200): status, what started it, its inputs and period, when, how long, and why it failed |
| GET | `/runs/:runId` | yes | One run with every step it took, in order: `{ stepKey, actionName, status, input, output, error, durationMs, pathId, actorUserId, at }` (`actorUserId`: who answered a waiting step), the items an "each" arrow fanned out into (`children`), its `parent`, where the case is (`paths`: each path's step and state) and who it waits on or was answered by (`tasks`). Inputs hold no secret: a saved connection is recorded by its id |
| POST | `/runs/:runId/cancel` | yes (`workflows:admin`) | `{ reason }` → stops a case still going; it fails as `CANCELLED` with who and why, and its tasks and links stop working. 400 `REASON_REQUIRED`, 409 `RUN_FINISHED` |
| POST | `/runs/:runId/retry` | yes (`workflows:admin`) | `{ reason }` → runs again the step a crash interrupted, once someone has checked it did not already do its work. 409 `NOT_INTERRUPTED` for any other case, `SEVERAL_PATHS` for one that was on several |
| GET | `/triggers` | yes | The kinds of trigger on offer (`manual`, `api`, `schedule`, `job`, and any a host registers), each `{ kind, label, description, fields }`: build a trigger form from it, and it never offers a kind the engine refuses |
| GET | `/workflows/by-trigger?kind=…&<setting>=…` | yes | The workflows a trigger starts, with `steps` — `?kind=job&jobId=<id>` is "what runs after this job". Each other query value matches that trigger setting |
| GET | `/workflows/:id/trigger` | yes | What its trigger last did: `{ trigger, on, lastFiredAt, lastRunId, lastSkippedAt, lastSkipReason, nextDueAt }` |
| POST | `/workflows/delete` | yes | `{ ids: [...] }` |
| POST | `/workflows/:id/run` | yes | `startRun(id, body)`. Runs synchronously to the first wait step or the end; 400 carries `{ message, code, details }` |
| GET | `/workflows/:id/steps/:stepKey/last-output` | yes | Output of the latest `success`/`waiting` step run for that key. No side effects |
| POST | `/workflows/:id/steps/try` | yes | **Runs the action for real** with `{ actionName, stepKey, values, params }`, interpolated against other steps' `sampleOutput`. Echoes the resolved `input` |
| POST | `/public/resume/:key` | **no** | Resume a wait step; body `{ output?, status?, error? }`. The host must also exempt `<mount>/public/*` from its own auth |
| GET | `/email-templates`, `/email-templates/:name` | yes | From `@xeplr/email` `templatesRouter`; mounted only if templates are initialised |
| POST | `/email-templates/save`, `/email-templates/delete`, `/email-templates/:name/preview` | yes | " |

### Triggers — what starts a workflow

A trigger is part of the workflow: save it with the workflow through `/workflows/save`, switch it off with `enabled: false`, and it only fires while the workflow is published. The engine README has every kind and its settings. Here, the routes above plus one example: a workflow that runs when a job finishes.

```json
POST /workflows/save
[{ "name": "After the nightly load", "status": "published",
   "trigger": { "kind": "job", "jobId": "<load>", "when": "success" },
   "steps": [{ "stepKey": "report", "actionName": "job-run", "kind": "wait", "position": 0,
               "values": { "jobId": "<report job>", "callbackUrl": "{resumeUrl}" } }] }]
```

There are no job-chain routes any more. A job's "After this job" is an ordinary workflow with a job trigger: the jobs screen reads the workflows a job starts from `/workflows/by-trigger?kind=job&jobId=…` and saves them through `/workflows/save`.

### Tasks — the inbox (`lib/tasksRouter.js`, over the engine's `lib/tasks.js`)

What people answer: a screen, or an approval (one task per approver). The
same envelope and per-route gate as `/flows` (`access: true` checks each
route's permission). Who may act is the engine's decision, from `req.user`
(`{ id, roles }`): a task for a user is theirs, for a role anyone's holding it,
for neither anyone's in the company; a Super Admin any. Errors are
`{ message, code }` with the status the engine chose.

| Method | Path | Right | Body → answer |
|---|---|---|---|
| GET | `/tasks/mine?limit=&offset=` | view | → `{ total, tasks: [{ id, runId, workflowName, stepKey, title, kind, status, assigneeUserId, assigneeRole, claimedBy, mine, dueAt, since, screen, buttons, given }] }`, due first, then oldest; `limit` ≤ 200. An approval's buttons are always `approved` / `rejected` |
| POST | `/tasks/:id/claim` | run | → the task, taken; nobody else answers it. 409 `TASK_CLAIMED` |
| POST | `/tasks/:id/release` | run | → the task, back for everyone it is for |
| POST | `/tasks/:id/answer` | run | An approval: `{ decision: 'approved' \| 'rejected', comment }` (a reject needs a reason: 400 `REASON_REQUIRED`). A screen: `{ values, action, recordId }`, as `/flows/runs/:runId/submit`. Refused: 403 `NOT_YOURS`, `NOT_SAME_PERSON` (the requester, or someone at a `notSame` step); 409 `TASK_CLAIMED`, `TASK_CLOSED` (withdrawn), `ALREADY_ANSWERED` |
| POST | `/tasks/:id/reassign` | admin | `{ userId \| role, reason }` → the task, moved, the move in its `history` |

### Flows — screens as steps (`lib/flowsRouter.js`, over the engine's `lib/flows.js`)

A **flow** is a workflow of kind `screens`: every step shows a screen (a
`@xeplr/ui-factory` form) to a person and waits for them to submit it, and the
transitions leaving it decide which screen comes next. The engine does not know
the difference — a screen step is an ordinary `wait` step whose action is
`screen-show`, and the submitted values are that step's `output`, so a
transition reads `output.<field>` exactly as it does anywhere else.

A flow is **designed in the app that owns the screens** (Configure UI → Flows),
through this facade, and addressed by a `key` that app chooses. The workflow
routes refuse to create or save one — *"This flow is designed in Configure UI"*
— and the builder shows it read-only. Runs and history are visible as usual.

**A flow no longer has to be one of these.** Since the designer offers a
Screen step, an app can draw an ordinary workflow — fetch, decide, ask a
person, carry on — give it a `key`, and run it through these same routes. So:

| | kind `screens` | an ordinary workflow with a `key` |
|---|---|---|
| designed by | the app that owns the screens, via `PUT /flows/:key` | the designer, like any workflow |
| `GET/PUT /flows/:key`, `publish` | yes | **no** — 404, they generate screens-only steps and would delete a design they cannot express |
| `POST /flows/:key/runs`, `GET /flows/:key/runs` | yes | **yes**, by key |
| `GET /flows/runs/:id`, `POST …/submit` | yes | **yes** |
| must be published to run | yes — publish is what checks the design | no; nothing else gates a workflow run either, and demanding a status it is never given would be a trap |

The engine never knew the difference; now the run routes do not either. Only
*designing* is still kind-gated.

Mounted at `<mount>/flows` by `registerWorkflow`, and returned on its own as
`flowsRouter` for a host that mounts it elsewhere. Every route is gated.

| Method | Path | Right | Body → answer |
|---|---|---|---|
| GET | `/flows` | view | → `[{ id, key, name, status, steps }]` (`steps` is a count) |
| POST | `/flows` | create | `{ key, name }` → the new draft flow |
| GET | `/flows/:key` | view | → `{ id, key, name, status, steps: [{ stepKey, label, screen, layout, transitions }] }` |
| PUT | `/flows/:key` | create | `{ name?, steps }` → the flow. Drafts only |
| POST | `/flows/:key/publish` | create | → the flow, once it checks out (below) |
| POST | `/flows/:key/runs` | run | → `{ runId, status, stepKey, screen }` |
| GET | `/flows/waiting` | view | Every screen waiting, in any workflow of this company, for one of the caller's roles (a screen step's `assignTo`; empty is anyone; a Super Admin sees all), oldest first: `[{ runId, workflowId, workflowName, stepKey, stepName, screen, assignTo, buttons, period, waitingSince }]`. The "waiting for you" list |
| GET | `/flows/runs/:runId` | view | → `{ runId, status, stepKey, screen, values, given, previous, assignTo, buttons }` — `values` is what that step already holds, so a resumed run reopens filled in; `given` is what the flow supplies to the screen (below); `previous` is what the screens before it saved (below) |
| POST | `/flows/runs/:runId/submit` | run | `{ values, recordId?, action?, stepKey? }` → the next `{ status, stepKey, screen, waitingOn }`, or `{ status: 'done' }`. A screen assigned to a role is refused to anyone without it (403 `NOT_YOURS`); one with `buttons` needs `action`, one of them, which becomes the step's `output.action`. **A case waiting on more than one screen at once** (parallel paths, engine 3.4) needs `stepKey` to say which this answers: without it, 409 `SAY_WHICH_STEP` naming them. The run view's `waitingOn` lists every step it waits on, `[{ stepKey, stepName, screen }]` |
| GET | `/flows/:key/runs?mine=1` | view | → runs still going, newest first |

**A transition is structured, never a formula**, in and out:

```json
{ "when": { "field": "type", "op": "=", "value": "contractor" }, "target": "contract" }
{ "when": null, "target": "payroll" }
```

`op` is one of `= != > >= < <= contains notContains startsWith endsWith in notIn
between isEmpty isNotEmpty` (the engine's own names, `eq`/`gt`…, are accepted on
the way in); `in`, `notIn` and `between` take a list. A `target` is a step key,
`end_success` or `end_failed`.

**Or let a function decide** — the app's own code, registered with
`@xeplr/actions` under `event: 'decide'`, picked by name:

```json
{ "when": null, "decide": "routeByAmount", "targets": ["review", "thanks"] }
```

```js
register({ name: 'routeByAmount', event: 'decide', description: 'Large requests go to review',
  execute: (ctx) => (Number(ctx.values.amount) > 1000 ? 'review' : 'thanks') })
```

`ctx.values` is what the screen just submitted; the answer is the next step's key
(or `end_success` / `end_failed`). `targets` lists the steps it may choose (none:
any step) — what the designer draws, and what publishing counts as reachable. An
answer outside them fails the run, naming the function. The designer lists the
functions to pick from with `@xeplr/factory`'s `GET /factory/functions`.

**What one screen saved is handed to the next** — `previous`, on every run
view, keyed by SCREEN key (not step key: a binding lives on the screen, and a
screen is the same form in every flow):

```json
{ "previous": { "department_edit": { "values": { "id": "dep_42", "name": "Finance", "region": "North" } } } }
```

`id` is the row that screen saved (`recordId` on submit). A field on a later
screen fills itself with a default of `{previous.department_edit.values.name}`
(`@xeplr/ui-factory`). No contract: a screen not reached on this branch is
absent and a binding to it is empty; a screen shown twice hands over its
latest. Declared contracts between steps are the paid workflow's.

**Publishing checks** that every step names a screen, every target exists, a
step has at most one catch-all and it comes last, every step leads somewhere
or ends, every step is reachable from the first, and every `decide` function is
registered for `decide` and may only choose steps of this flow.

**The browser never holds a resume key.** Submit is an authenticated call; the
facade finds the waiting step's key itself and resumes through `resumeByKey`.
`recordId` — the row the screen wrote into its own table — is kept on the step's
output, so later steps and their conditions can use it.

**A screen step takes inputs, like any other step.** `screen-show` declares
`screen` and `values`:

```json
{ "screen": "containment_edit",
  "values": { "complaintId": "{steps.d1.output.recordId}" } }
```

`values` is resolved by `interpolateAll` before the run parks — the same code
that resolves an email's `to` — and comes back as `given` on the run, already
substituted. So a form that says a field is filled in by whoever opens it
(`@xeplr/ui-factory`'s `filledBy: 'caller'`) gets its answer from the flow,
and the person is never asked for the id of the thing they are working on.
This is what lets one flow write to several tables and keep them linked.

Read off the STEP RUN, not the step row: the row holds the tokens and the
browser has nothing to resolve them with.

**A screen is not only for a flow of screens.** The designer offers *Screen*
beside *Action* and *Condition* (`@xeplr-workflow/ui`), so an ordinary
workflow can fetch, decide, ask a person and carry on. That used to be a trap:
the engine parked the run correctly — a screen step is a wait step like any
other — while the two routes that show and resume one answered 404 unless the
whole workflow was kind `screens`. So **`GET /flows/runs/:runId` and
`POST …/submit` now take a run of any workflow.** Designing, validating and
publishing a *flow* still require kind `screens`; this is only about a run
that is sitting on a screen, whoever put it there.

**Only a screen is submitted there.** Now that any run reaches the route,
"waiting" is no longer the same as "waiting for a person": a step can be
parked on an email that has not arrived or a callback nobody has made, and
those resume through the engine's own key, from whatever they are waiting FOR.
Submitting one is refused with `NOT_A_SCREEN`, naming the step — otherwise
somebody standing in front of a run could hand it the answer it was waiting
for the world to give.

**A run belongs to the company it was started in.** Another company's flow is
not there, and its run ids are 404, not 403 — nothing confirms they exist.

Rights come from `migrations-auth/0004_flows_access.sql`: submitting is a
**run** right, not a view right, because it moves the run on and everything
after it follows.

## Auth catalog (`migrations-auth/`)

Not run by this package. A host points `XEPLR_AUTH_MIGRATIONS` at this folder, and `@xeplr/auth` applies it (`xeplr-auth-server` boot or `xeplr-auth-migrate up`) after auth's own migrations.

| Migration | Creates |
|---|---|
| `migrations-auth/0001_workflow_access` | Roles `Super Admin`, `CompanyAdmin`, `Creator`, `Viewer`; menus `Home`, `Actions`, `Configuration`, `Access Control`; `apis` rows; role → menu/api matrix |
| `migrations-auth/0003_nav_menus` | Menus `Dashboards`, `Jobs`, `Select Workspace`, `Select Company` (all `workflows:view`) + mappings |
| `migrations-auth/0004_flows_access` | The flows routes' `apis` rows (`List flows`, `Start flow run`…) and their role mappings |
| `migrations-auth/0006_workflow_job_chains_access` | The former `/job-chains` routes' rows, kept: stale rows cost nothing |
| `migrations-auth/0007_workflow_trigger_access` | The trigger routes' `apis` rows (`List trigger kinds`, `Find workflows by trigger`, `Get workflow trigger`, all `workflows:view`) and their role mappings: Super Admin, CompanyAdmin, Creator and Viewer |
| `migrations-auth/0008_workflow_run_history_access` | The run-history routes' `apis` rows (`List workflow runs`, `Get workflow run`, `workflows:view`) for Super Admin, CompanyAdmin, Creator and Viewer |
| `migrations-auth/0009_screens_waiting_access` | `List screens waiting` (`workflows:view`) for Super Admin, CompanyAdmin, Creator and Viewer; `Submit flow screen` for Viewer too, since a screen's own role (`assignTo`) is the real gate |
| `migrations-auth/0010_tasks_and_admin_access` | The inbox (`List my tasks`, `workflows:view`) and `Take task`, `Put task back`, `Answer task` (`workflows:run`) for every role, Viewer too — the task's own user or role is the real gate. A new group **`workflows:admin`** — `Reassign task`, `Cancel run`, `Retry run` — for Super Admin and CompanyAdmin only: they are decisions about other people's work |
| `migrations-auth/0005_workflow_license_module` | Every `workflows:*` api row tagged `licenseModule = 'workflow'` (Xeplr Workflow is licensed apart from its host). Nothing filters on it yet |

The package reads this folder from disk (`"xeplr": { "readsFromDisk": ["migrations-auth"] }`), so a build that compiles it must ship the folder beside it.

## Rules the code enforces, and why

| Rule | Why (from the code comments) |
|---|---|
| Action catalog is a **whitelist** (`WANTED`, `LOCAL`, `WANTED_WITH_META`) | Offering a dangerous built-in should be a visible decision in a diff, not a side effect of upgrading. Placeholders in `@xeplr/actions` would appear in the picker and fail when used |
| `spawnProgram` is deliberately absent (asserted in tests) | It runs arbitrary executables |
| Placeholders (no `execute`/`name`) are skipped and logged, not thrown | The app works without them; they land when the package implements them |
| `{env.*}` reaches only names in `WORKFLOW_ENV_EXPOSED`; exact names, no globs | Resolved step input is echoed by `/steps/try` and persisted on step runs, so an unlisted env would let any step author read `ENCRYPTION_KEY` / `AUTH_JWT_SECRET`. An allowlist fails closed when someone adds a new secret |
| Never put a credential in `WORKFLOW_ENV_EXPOSED` | Secrets belong where the action reads them server-side (e.g. `useCustomConnection: false` with `SMTP_*`) |
| `WORKFLOW_PUBLIC_URL` is not defaulted | A wrong-but-present callback address makes a run wait forever on work that finished; unset, `job-run` refuses by name |
| Models are always bound via `db.model(name)`; connection uses `bind: false` | `bindModels` is global in Objection; binding workflow's connection globally re-pointed the host's models at workflow's database |
| `registerWorkflow` runs the engine's migrations and action registration (`startEngine`) | Previously only standalone did, so embedded hosts got missing tables and an empty catalog with no error |
| `xeplr_configs` is fail-fast standalone, best-effort embedded | Standalone owns its process and should not boot half-configured; embedded, one metadata-writing action should not take down the host's product |
| An application id must be registered | Rows written to shared `xeplr_configs` are attributed by application |
| Hosts must not mount the router at `/` | It serves `/companies`, `/workspaces`, `/actions`, which a host already serves |
| Hosts should take the router, not `app.use()` it onto a built createApp app | createApp adds a catch-all 404 after its routes, so later mounts are unreachable |
| `/steps/try` is real execution; the UI confirms first | Same `runAction` the engine uses — `email-delete` expunges, `db-push` writes |
| `/public/resume/:key` is ungated | A resume link is followed from an email client or a job callback with no token |
| `resumeByKey` refuses (`RESUME_KEY_NOT_READY`) until the step is `waiting`; claim is an atomic conditional patch | The key exists before the action finishes (mail scanners pre-fetch links); resuming mid-action would route the run on while the action is still running |
| `job-run`: HTTP 409 from the jobs API is a failure, not a retry | A chain must not continue past a movement that never ran |
| Role matrix: Creator can run, Viewer cannot | A run has side effects (mail, files, database writes) |

## Tests

```bash
npm test          # node test/run.mjs — each *.test.mjs in its own process
```

Plain scripts, no framework; each prints `ok`/`FAIL` lines and exits non-zero on failure. A suite that needs node flags declares them in a `// @flags:` header. `flows.test.mjs`, `triggersRoutes.test.mjs`, `tasksRoutes.test.mjs` and `authMigrations.test.mjs` need a real Postgres (`WORKFLOW_TEST_PG`) and are skipped without it; CI and the release start one, so neither ships on a skipped suite.

| Suite | Covers |
|---|---|
| `flows.test.mjs` | On a real Postgres: the `/flows` routes over the real engine — flows as workflows, steps and arrows, runs and submits |
| `triggersRoutes.test.mjs` | Triggers over HTTP on the real engine and Postgres (`WORKFLOW_TEST_PG`, skipped without it):
- a job trigger saved as part of an ordinary workflow
- a bad cron and an unknown kind refused with the reason
- an arrow written as `when` saved with its compiled condition, and a bad one refused
- `/triggers`
- `/workflows/by-trigger` by job and by kind
- `/workflows/:id/trigger`
- switching a trigger off
- another company seeing none of it |
| `tasksRoutes.test.mjs` | On a real Postgres, over HTTP: an approval saved and started; each person's `/tasks/mine` (not the requester's, not another company's); claim and the refusal to another; a reject needing a reason; a task for another role refused; the run showing who answered, the deciding step's actor and its paths; reassign and cancel needing reasons; retry refused for a case not interrupted; another company unable to cancel; the per-route permission check |
| `authMigrations.test.mjs` | `@xeplr/auth`'s migrations then `migrations-auth/` applied to a scratch Postgres, as the auth server applies them: every workflow route row reaches a role besides Super Admin; the inbox for every role; the admin actions for the admins only, in `workflows:admin`; running every file again adds nothing |
| `requires.test.mjs` | Every relative `require` in this package points at a file (Node only notices a missing one when the line runs) |
| `flowsAccess.test.mjs` | With `access: true`, each flows route refuses a caller lacking its permission, and refuses outright with no `req.access`; off by default |

Not covered by tests: the workflow builder's own save/run routes beyond what the suites above drive, `job-run`.
