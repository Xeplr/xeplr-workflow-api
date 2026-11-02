// @flags: --preserve-symlinks
//
// THE STEP PREVIEW over HTTP, on the real engine, real Postgres and a real
// folder: a step that reads answers with its first rows, its input resolved
// from another step's sample output as a run would resolve it; a step that
// writes answers with its example and is NOT run (the file is still there);
// an incomplete step says what is missing; no action named is refused.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const express = require('express')
const { registerApplication, mtMiddleware, runWithMt, dataDir } = require('@xeplr/db')
const engine = require('@xeplr/workflow-engine')
const buildWorkflowRouter = require('../lib/router')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 400))) }

const WF_DB = 'xeplr_wf_step_preview_test_' + Date.now()
registerApplication('xeplr-workflow-test')
await engine.startEngine({
  db: {
    name: WF_DB, connection: PG, connectionName: 'workflow_step_preview_test',
    mts: { l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } }
  },
  schedule: false
})

const HEADERS = { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-workspace-id': 'w1' }
const call = async (url, method, body) => {
  const res = await fetch(url, { method: method || 'GET', headers: HEADERS, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  // The company's own folder, with a file in it.
  const folder = runWithMt({ mtId1: 'c1', mtId2: 'w1' }, () => dataDir.tenantFolder())
  mkdirSync(path.join(folder, 'bank'), { recursive: true })
  writeFileSync(path.join(folder, 'bank', 'sept.ndjson'), Array.from({ length: 9 }, (_, i) => JSON.stringify({ ref: 'R' + i, amount: i })).join('\n') + '\n')

  const app = express()
  app.use(express.json())
  app.use(mtMiddleware())
  app.use('/workflow', buildWorkflowRouter({}))
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/workflow`

  // A step before it whose sample output names the file: the preview reads
  // {steps.pick.output.path} as a run would.
  const saved = await call(base + '/workflows/save', 'POST', [{
    name: 'Bank file', status: 'draft', steps: [
      { stepKey: 'pick', name: 'Pick', actionName: 'decide', kind: 'auto', position: 0, sampleOutput: { path: 'bank/sept.ndjson' } },
      { stepKey: 'read', name: 'Read', actionName: 'file-read', kind: 'auto', position: 1 }
    ]
  }])
  const wfId = saved.body.updatedIds[0]

  const read = await call(base + '/workflows/' + wfId + '/steps/preview', 'POST', { actionName: 'file-read', stepKey: 'read', values: { path: '{steps.pick.output.path}' } })
  const r = read.body && read.body.dataArray && read.body.dataArray[0]
  check('a step that reads: its first rows, in the shape it hands on', read.status === 200 && r.status === 'success' && r.output.rows.length === 5 && r.rows[0].ref === 'R0', read.body)
  check('...its input resolved from the step before\'s sample output', r && r.input.path === 'bank/sept.ndjson', r && r.input)

  const del = await call(base + '/workflows/' + wfId + '/steps/preview', 'POST', { actionName: 'file-delete', stepKey: 'read', values: { path: 'bank/sept.ndjson' } })
  const d = del.body.dataArray[0]
  check('a step that writes: its example, and nothing ran', d.status === 'example' && d.output.deleted === true && existsSync(path.join(folder, 'bank', 'sept.ndjson')), d)

  const missing = await call(base + '/workflows/' + wfId + '/steps/preview', 'POST', { actionName: 'file-read', stepKey: 'read', values: {} })
  const m = missing.body.dataArray[0]
  check('an incomplete step says what is missing', m.status === 'failed' && /path/.test(m.error.message), m)

  const none = await call(base + '/workflows/' + wfId + '/steps/preview', 'POST', { values: {} })
  check('no action named is refused', none.status === 400)
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
