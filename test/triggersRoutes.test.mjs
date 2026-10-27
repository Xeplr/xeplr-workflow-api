// @flags: --preserve-symlinks
//
// Triggers over HTTP, on the real engine and a real Postgres: a trigger is
// saved as part of an ordinary workflow through /workflows/save and refused
// there when it could never fire; the kinds on offer; the workflows a given
// trigger starts (what the jobs screen's "After this job" reads); what one
// workflow's trigger last did; and another company seeing none of it.
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

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 400))) }

const WF_DB = 'xeplr_wf_trigger_routes_test_' + Date.now()
registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_trigger_routes_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false
})

const HEADERS = { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-workspace-id': 'w1' }
const call = async (url, method, body, headers) => {
  const res = await fetch(url, { method: method || 'GET', headers: { ...HEADERS, ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  const app = express()
  app.use(express.json())
  app.use(mtMiddleware())
  // Who is signed in, as the auth gate would set it: roles by name.
  app.use((req, res, next) => { if (req.headers['x-test-roles']) req.user = { id: 'u-' + req.headers['x-test-roles'], roles: String(req.headers['x-test-roles']).split(',') }; next() })
  app.use('/workflow', buildWorkflowRouter({}))
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/workflow`

  const kinds = await call(base + '/triggers')
  check('GET /triggers lists the kinds', kinds.status === 200 && kinds.body.dataArray.map((k) => k.kind).join(',') === 'manual,api,schedule,job', kinds.body)
  const jobKind = kinds.body.dataArray.find((k) => k.kind === 'job')
  check('...with the words and the fields a form asks for', jobKind && jobKind.label === 'A job finishes' && jobKind.fields.map((f) => f.name).join() === 'jobId,when', jobKind)

  const step = { stepKey: 'decide', name: 'Decide', actionName: 'decide', kind: 'auto', position: 0 }
  const saved = await call(base + '/workflows/save', 'POST', [{
    name: 'After the load', status: 'published', trigger: { kind: 'job', jobId: 'jLoad', when: 'finished' }, steps: [step]
  }])
  check('a job trigger saves as part of an ordinary workflow', saved.status === 200, saved.body)
  const id = saved.body && saved.body.updatedIds && saved.body.updatedIds[0]
  await call(base + '/workflows/save', 'POST', [{ name: 'After another job', status: 'published', trigger: { kind: 'job', jobId: 'jOther' }, steps: [step] }])
  await call(base + '/workflows/save', 'POST', [{ name: 'Mondays', status: 'published', trigger: { kind: 'schedule', cron: '0 9 * * 1' }, steps: [step] }])

  const bad = await call(base + '/workflows/save', 'POST', [{ name: 'Broken', trigger: { kind: 'schedule', cron: 'every day' }, steps: [step] }])
  check('a trigger that could never fire is refused with 400, saying why', bad.status === 400 && bad.body.code === 'TRIGGER_INVALID' && /cron expression/.test(JSON.stringify(bad.body)), bad)
  const unknown = await call(base + '/workflows/save', 'POST', [{ name: 'Odd', trigger: { kind: 'telepathy' } }])
  check('...and an unknown kind', unknown.status === 400 && /not a kind of trigger/.test(JSON.stringify(unknown.body)), unknown)

  const found = await call(base + '/workflows/by-trigger?kind=job&jobId=jLoad')
  check('by-trigger finds the workflows that job starts, with their steps',
    found.status === 200 && found.body.dataArray.length === 1 && found.body.dataArray[0].id === id && found.body.dataArray[0].steps.length === 1, found.body)
  const allJobs = await call(base + '/workflows/by-trigger?kind=job')
  check('...every job-triggered workflow when no job is named', allJobs.body.dataArray.length === 2)
  const noKind = await call(base + '/workflows/by-trigger')
  check('...and asks for a kind when none is given', noKind.status === 400)

  const state = await call(base + '/workflows/' + id + '/trigger')
  check('GET /workflows/:id/trigger says it is on and has not fired', state.status === 200 && state.body.dataArray[0].on === true && state.body.dataArray[0].lastFiredAt === null, state.body)
  const missing = await call(base + '/workflows/nope/trigger')
  check('...404 for a workflow that is not there', missing.status === 404)

  const off = await call(base + '/workflows/save', 'POST', [{ id, name: 'After the load', trigger: { kind: 'job', jobId: 'jLoad', when: 'finished', enabled: false } }])
  check('switching it off is an ordinary save', off.status === 200 && (await call(base + '/workflows/' + id + '/trigger')).body.dataArray[0].on === false, off.body)

  const decided = await call(base + '/workflows/save', 'POST', [{ name: 'Branching', status: 'published', trigger: { kind: 'job', jobId: 'jBranch', when: 'finished' }, steps: [
    { stepKey: 'decide', name: 'Decide', actionName: 'decide', kind: 'auto', position: 0,
      transitions: [{ when: { field: 'trigger.status', op: '=', value: 'success' }, mode: 'single', target: 'end_success' }, { when: null, mode: 'single', target: 'end_failed' }] }
  ] }])
  const branch = (await call(base + '/workflows/by-trigger?kind=job&jobId=jBranch')).body.dataArray[0]
  const arrows = branch && branch.steps[0].transitions
  check('an arrow written as `when` is saved with its compiled condition', decided.status === 200 && arrows && arrows[0].condition.op === 'eq' && arrows[0].when.op === '=' && arrows[1].condition === null, arrows)
  const badArrow = await call(base + '/workflows/save', 'POST', [{ name: 'Bad arrow', steps: [{ stepKey: 'd', name: 'D', actionName: 'decide', position: 0, transitions: [{ when: { field: 'trigger.status', op: 'like', value: 1 }, target: 'end_success' }] }] }])
  check('...and a bad one is refused with 400, naming the step and arrow', badArrow.status === 400 && /Step "D", arrow 1.*not a comparison/.test(badArrow.body.message), badArrow.body)

  const noList = await call(base + '/workflows/save', 'POST', [{ name: 'Each without a list', steps: [
    { stepKey: 'fetch', name: 'Fetch', actionName: 'decide', position: 0, transitions: [{ mode: 'each', target: 'one' }] },
    { stepKey: 'one', name: 'One', actionName: 'decide', position: 1 }
  ] }])
  check('an each arrow without its list is refused with 400, saying what it needs', noList.status === 400 && noList.body.code === 'TRANSITION_INVALID' && /Step "Fetch", arrow 1.*`source`/.test(noList.body.message), noList.body)
  const withList = await call(base + '/workflows/save', 'POST', [{ name: 'Each with a list', steps: [
    { stepKey: 'fetch', name: 'Fetch', actionName: 'decide', position: 0, transitions: [{ mode: 'each', source: 'output.rows', target: 'one' }] },
    { stepKey: 'one', name: 'One', actionName: 'decide', position: 1 }
  ] }])
  check('...and saved with it', withList.status === 200, withList.body)

  // Run history: a workflow's runs, and one run with every step it took.
  const hist = await call(base + '/workflows/save', 'POST', [{ name: 'History', status: 'published', steps: [
    { stepKey: 'a', name: 'A', actionName: 'decide', position: 0, transitions: [{ mode: 'single', target: 'b' }] },
    { stepKey: 'b', name: 'B', actionName: 'recall', position: 1, values: { key: 'k' }, transitions: [{ mode: 'single', target: 'end_success' }] }
  ] }])
  const hid = hist.body.updatedIds[0]
  const started = await call(base + '/workflows/' + hid + '/run', 'POST', {})
  const runId = started.body.dataArray[0].id
  const runs = await call(base + '/workflows/' + hid + '/runs')
  check('GET /workflows/:id/runs lists its runs, newest first', runs.status === 200 && runs.body.dataArray.length === 1 && runs.body.dataArray[0].id === runId && runs.body.dataArray[0].status === 'success', runs.body)
  const one = await call(base + '/runs/' + runId)
  const st = one.body.dataArray && one.body.dataArray[0].steps
  check('GET /runs/:runId gives every step it took, in order, with what came out', one.status === 200 && st.map((x) => x.stepKey).join() === 'a,b' && st[1].output.found === false && st[1].input.key === 'k' && st[0].at, one.body)
  check('...a run not there is 404', (await call(base + '/runs/nope')).status === 404)
  check('...and another company sees none of it', (await call(base + '/runs/' + runId, 'GET', null, { 'x-company-id': 'c2' })).status === 404 &&
    (await call(base + '/workflows/' + hid + '/runs', 'GET', null, { 'x-company-id': 'c2' })).body.dataArray.length === 0)

  // Screens inside a workflow: waiting for a role, answered with a button.
  const rev = await call(base + '/workflows/save', 'POST', [{ name: 'Review', status: 'published', steps: [
    { stepKey: 'review', name: 'Review', actionName: 'screen-show', kind: 'wait', position: 0,
      values: { screen: 'unmatched_review', assignTo: 'Accounts', buttons: ['approve', 'send_back'] },
      transitions: [{ when: { field: 'output.action', op: '=', value: 'approve' }, target: 'end_success' }, { when: null, target: 'end_failed' }] }
  ] }])
  const rr = await call(base + '/workflows/' + rev.body.updatedIds[0] + '/run', 'POST', {})
  const rrId = rr.body.dataArray[0].id
  const forAccounts = await call(base + '/flows/waiting', 'GET', null, { 'x-test-roles': 'Accounts' })
  check('GET /flows/waiting lists the screen for its role', forAccounts.status === 200 && forAccounts.body.length === 1 && forAccounts.body[0].runId === rrId && forAccounts.body[0].buttons.length === 2, forAccounts.body)
  const forSales = await call(base + '/flows/waiting', 'GET', null, { 'x-test-roles': 'Sales' })
  check('...and not for another role', forSales.status === 200 && forSales.body.length === 0, forSales)
  const salesTry = await call(base + '/flows/runs/' + rrId + '/submit', 'POST', { values: {}, action: 'approve' }, { 'x-test-roles': 'Sales' })
  check('submitting it as another role is refused, 403', salesTry.status === 403 && salesTry.body.code === 'NOT_YOURS', salesTry.body)
  const approved = await call(base + '/flows/runs/' + rrId + '/submit', 'POST', { values: {}, action: 'approve' }, { 'x-test-roles': 'Accounts' })
  check('...and as Accounts, Approve finishes it', approved.status === 200 && approved.body.status !== 'waiting', approved.body)

  const other = await call(base + '/workflows/by-trigger?kind=job', 'GET', null, { 'x-company-id': 'c2' })
  check('another company sees none of them', other.status === 200 && other.body.dataArray.length === 0)
  server.close()
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  engine.triggers.stopTicking()
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
