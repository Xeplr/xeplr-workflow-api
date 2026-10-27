// The inbox and the admin actions over HTTP, on the real engine and Postgres:
// an approval saved through /workflows/save and started, each person's
// /tasks/mine, taking and answering, the run showing who answered, an admin
// reassigning and cancelling, another company seeing none of it, and the
// per-route permission check.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const express = require('express')
const { registerApplication, mtMiddleware } = require('@xeplr/db')
const engine = require('@xeplr/workflow-engine')
const buildWorkflowRouter = require('../lib/router')
const buildTasksRouter = require('../lib/tasksRouter')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 500))) }

const WF_DB = 'xeplr_wf_tasks_routes_test_' + Date.now()
registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_tasks_routes_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false, recover: false
})

// Who is signed in, as the auth gate would put it on the request.
const as = (id, roles, company) => ({ 'x-test-user': id, 'x-test-roles': roles.join(','), 'x-company-id': company || 'c1' })
const RAVI = as('u_ravi', ['Creator'])
const MEERA = as('u_meera', ['QA Head'])
const MIRA = as('u_mira', ['QA Head'])
const NEIL = as('u_neil', ['Production Head'])
const ADMIN = as('u_admin', ['Super Admin'])
const call = async (url, method, body, headers) => {
  const res = await fetch(url, { method: method || 'GET', headers: { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-workspace-id': 'w1', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  const app = express()
  app.use(express.json())
  app.use(mtMiddleware())
  app.use((req, res, next) => {
    if (req.headers['x-test-user']) req.user = { id: req.headers['x-test-user'], roles: String(req.headers['x-test-roles'] || '').split(',').filter(Boolean) }
    next()
  })
  app.use('/workflow', buildWorkflowRouter({}))
  // The same router with its per-route permissions on, as a host with access: true mounts it.
  app.use('/gated', (req, res, next) => { req.access = { apis: ['List my tasks'] }; next() }, buildTasksRouter({ access: true }))
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/workflow`

  const saved = await call(base + '/workflows/save', 'POST', [{ name: 'Deviation sign-off', status: 'published', steps: [
    { stepKey: 'sign', name: 'Sign off', actionName: 'approval', kind: 'wait', position: 0,
      values: { approvers: 'QA Head, Production Head', title: 'Deviation on PO 450103 / 10' },
      transitions: [{ when: { field: 'output.decision', op: '=', value: 'approved' }, target: 'end_success' }, { when: null, target: 'end_failed' }] }
  ] }], RAVI)
  check('an approval step saves through /workflows/save', saved.status === 200, saved.body)
  const wfId = saved.body.updatedIds[0]
  const started = await call(base + '/workflows/' + wfId + '/run', 'POST', {}, RAVI)
  const runId = started.body.dataArray[0].id
  check('...and starts, waiting', started.status === 200 && started.body.dataArray[0].status === 'waiting', started.body)

  const meeraInbox = await call(base + '/tasks/mine', 'GET', null, MEERA)
  const qa = meeraInbox.body.tasks && meeraInbox.body.tasks[0]
  check('GET /tasks/mine: Meera has hers, titled', meeraInbox.status === 200 && meeraInbox.body.total === 1 && qa.title === 'Deviation on PO 450103 / 10' && qa.workflowName === 'Deviation sign-off', meeraInbox.body)
  check('...Ravi, who raised it, has none', (await call(base + '/tasks/mine', 'GET', null, RAVI)).body.total === 0)
  check('...another company has none', (await call(base + '/tasks/mine', 'GET', null, as('u_meera', ['QA Head'], 'c2'))).body.total === 0)

  check('POST /tasks/:id/claim takes it', (await call(base + '/tasks/' + qa.id + '/claim', 'POST', {}, MEERA)).status === 200)
  const taken = await call(base + '/tasks/' + qa.id + '/claim', 'POST', {}, MIRA)
  check('...another QA Head is refused, 409 TASK_CLAIMED', taken.status === 409 && taken.body.code === 'TASK_CLAIMED', taken.body)
  const noReason = await call(base + '/tasks/' + qa.id + '/answer', 'POST', { decision: 'rejected' }, MEERA)
  check('a reject without a reason is 400 REASON_REQUIRED', noReason.status === 400 && noReason.body.code === 'REASON_REQUIRED', noReason.body)
  check('POST /tasks/:id/answer approves', (await call(base + '/tasks/' + qa.id + '/answer', 'POST', { decision: 'approved' }, MEERA)).status === 200)
  const prod = (await call(base + '/tasks/mine', 'GET', null, NEIL)).body.tasks[0]
  const notHis = await call(base + '/tasks/' + prod.id + '/answer', 'POST', { decision: 'approved' }, MEERA)
  check('...a task for another role is 403 NOT_YOURS', notHis.status === 403 && notHis.body.code === 'NOT_YOURS', notHis.body)
  await call(base + '/tasks/' + prod.id + '/answer', 'POST', { decision: 'approved', comment: 'fine' }, NEIL)

  const run = (await call(base + '/runs/' + runId)).body.dataArray[0]
  check('the run is done', run.status === 'success', run.status)
  check('...GET /runs/:runId shows who answered each task', run.tasks.length === 2 && run.tasks.map((t) => t.decidedBy).sort().join() === 'u_meera,u_neil', run.tasks)
  check('...the step who decided it, and where the case went', run.steps[0].actorUserId === 'u_neil' && run.paths.length === 1 && run.paths[0].status === 'done', { steps: run.steps, paths: run.paths })

  console.log('\nadmin')
  const r2 = (await call(base + '/workflows/' + wfId + '/run', 'POST', {}, RAVI)).body.dataArray[0].id
  const t2 = (await call(base + '/tasks/mine', 'GET', null, MEERA)).body.tasks.find((t) => t.runId === r2)
  const noWhy = await call(base + '/tasks/' + t2.id + '/reassign', 'POST', { userId: 'u_chen' }, ADMIN)
  check('reassign without a reason is 400', noWhy.status === 400 && noWhy.body.code === 'REASON_REQUIRED', noWhy.body)
  const moved = await call(base + '/tasks/' + t2.id + '/reassign', 'POST', { userId: 'u_chen', reason: 'Meera on leave' }, ADMIN)
  check('POST /tasks/:id/reassign moves it, with why', moved.status === 200 && moved.body.assigneeUserId === 'u_chen' && moved.body.history[0].by === 'u_admin', moved.body)
  check('...to Chen\'s inbox', (await call(base + '/tasks/mine', 'GET', null, as('u_chen', []))).body.tasks.some((t) => t.id === t2.id))
  const noCancelWhy = await call(base + '/runs/' + r2 + '/cancel', 'POST', {}, ADMIN)
  check('cancel without a reason is 400', noCancelWhy.status === 400 && noCancelWhy.body.code === 'REASON_REQUIRED', noCancelWhy.body)
  const cancelled = await call(base + '/runs/' + r2 + '/cancel', 'POST', { reason: 'Raised twice' }, ADMIN)
  check('POST /runs/:runId/cancel stops it, saying who and why', cancelled.status === 200 && cancelled.body.dataArray[0].error.code === 'CANCELLED' && cancelled.body.dataArray[0].error.by === 'u_admin', cancelled.body)
  check('...again is 409', (await call(base + '/runs/' + r2 + '/cancel', 'POST', { reason: 'x' }, ADMIN)).status === 409)
  const retry = await call(base + '/runs/' + runId + '/retry', 'POST', { reason: 'x' }, ADMIN)
  check('POST /runs/:runId/retry on a case that was not interrupted is 409 NOT_INTERRUPTED', retry.status === 409 && retry.body.code === 'NOT_INTERRUPTED', retry.body)
  check('a case in another company cannot be cancelled', (await call(base + '/runs/' + runId + '/cancel', 'POST', { reason: 'x' }, as('u_admin', ['Super Admin'], 'c2'))).status === 404)

  console.log('\nper-route permissions (access: true)')
  const gated = `http://127.0.0.1:${server.address().port}/gated`
  check('a permission the caller has: past the check', (await call(gated + '/mine', 'GET', null, MEERA)).status === 200)
  const denied = await call(gated + '/' + t2.id + '/answer', 'POST', { decision: 'approved' }, MEERA)
  check('one it lacks: 403 naming it', denied.status === 403 && /Answer task/.test(denied.body.message), denied.body)
  check('every tasks route has a permission name', Object.keys(buildTasksRouter.API_NAMES).length === 5)

  server.close()
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
