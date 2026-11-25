// A RUNNING STEP, WATCHED AND STOPPED THROUGH THE API: GET /runs/:runId hands
// back a running step's progress and log (engine 4.3.1, saved as it runs), and
// POST /runs/:runId/cancel stops that step part-way. Over real HTTP, through
// the real router, on the real engine and a real Postgres.
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
const { registerApplication, mtMiddleware, runWithMt } = require('@xeplr/db')
const actions = require('@xeplr/actions')
const engine = require('@xeplr/workflow-engine')
const buildWorkflowRouter = require('../lib/router')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 500))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WF_DB = 'xeplr_wf_run_progress_test_' + Date.now()
registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: { name: WF_DB, connection: PG, connectionName: 'workflow_run_progress_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } } }
})

// A load of a million rows, 1,000 a batch, 40 ms a batch: it reports every batch.
let stoppedAfter = null
actions.register({ name: 'slow-load', inputSchema: [{ name: 'rows', type: 'number' }],
  execute: async (ctx) => {
    const sys = ctx.system || {}
    sys.log('Loading ' + ctx.input.rows + ' rows')
    for (let done = 1000; done <= ctx.input.rows; done += 1000) {
      if (sys.signal && sys.signal.aborted) { stoppedAfter = done - 1000; throw sys.signal.reason }
      await sleep(40)
      sys.onProgress({ rowsWritten: done, percent: Math.round((done / ctx.input.rows) * 100) })
    }
    return { rows: ctx.input.rows }
  } })

const MT = { mtId1: 'c1', mtId2: 'w1' }
const headers = { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-workspace-id': 'w1', 'x-test-user': 'u_admin', 'x-test-roles': 'Super Admin' }
const call = async (url, method, body) => {
  const res = await fetch(url, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}

let server = null
try {
  const app = express()
  app.use(express.json())
  app.use(mtMiddleware())
  app.use((req, res, next) => { req.user = { id: req.headers['x-test-user'], roles: String(req.headers['x-test-roles'] || '').split(',').filter(Boolean) }; next() })
  app.use('/workflow', buildWorkflowRouter({}))
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/workflow`

  const saved = await call(base + '/workflows/save', 'POST', [{ name: 'Load a million', status: 'published', steps: [
    { stepKey: 'load', name: 'Load', actionName: 'slow-load', kind: 'auto', position: 0, values: { rows: 1000000 },
      transitions: [{ when: null, target: 'end_success' }] }
  ] }])
  const wfId = saved.body.updatedIds[0]
  const going = runWithMt(MT, () => engine.runner.startRun(wfId, {}))
  let runId = null
  for (let i = 0; i < 100 && !runId; i++) {
    const list = await call(base + '/workflows/' + wfId + '/runs')
    runId = list.body && list.body.dataArray && list.body.dataArray[0] && list.body.dataArray[0].id
    if (!runId) await sleep(50)
  }
  await sleep(2600)
  const seen = await call(base + '/runs/' + runId)
  const step = seen.body.dataArray[0].steps.find((s) => s.stepKey === 'load')
  check('GET /runs/:runId: the running step\'s numbers, as they are now', step.status === 'running' && step.progress && step.progress.rowsWritten > 0 &&
    step.progress.percent > 0 && step.progress.percent < 100 && typeof step.progress.at === 'string', step)
  check('...and its log so far', Array.isArray(step.log) && step.log[0].message === 'Loading 1000000 rows', step.log)
  await sleep(2100)
  const later = (await call(base + '/runs/' + runId)).body.dataArray[0].steps.find((s) => s.stepKey === 'load')
  check('asked again a few seconds later, it has moved', later.progress.rowsWritten > step.progress.rowsWritten, { before: step.progress, after: later.progress })

  const cancelled = await call(base + '/runs/' + runId + '/cancel', 'POST', { reason: 'wrong file' })
  await going.catch(() => {})
  const after = (await call(base + '/runs/' + runId)).body.dataArray[0]
  check('POST /runs/:runId/cancel stops the running step part-way', cancelled.status === 200 && stoppedAfter !== null && stoppedAfter < 1000000 &&
    after.status === 'failed' && after.error.code === 'CANCELLED' && after.steps[0].status === 'failed', { status: cancelled.status, stoppedAfter, run: after.status })
} catch (err) {
  check('no unexpected error', false, err && (err.stack || err.message))
} finally {
  if (server) server.close()
  await engine.db.conn().destroy().catch(() => {})
  const admin = require('knex')({ client: 'pg', connection: { ...PG, database: 'postgres' } })
  await admin.raw(`DROP DATABASE IF EXISTS "${WF_DB}" WITH (FORCE)`).catch(() => {})
  await admin.destroy()
  const failed = results.filter((r) => !r).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
}
