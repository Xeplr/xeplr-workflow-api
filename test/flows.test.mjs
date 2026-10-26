// @flags: --preserve-symlinks
// (Linked @xeplr/* packages resolve their peers from this app's node_modules —
// see actionCatalog.test.mjs.)
//
// A SCREEN IS A STEP, AND A FLOW IS A WORKFLOW. This suite drives the flows
// facade over real HTTP, through the real express router, against the REAL
// engine — startRun, the wait machinery, resumeByKey, routeAfterStep and
// @xeplr/expression-handler are all the shipped ones. Only the storage is
// swapped (test/fakeDb.mjs), because the claim worth checking is not "the
// facade calls what I said it calls" but "a person filling in two screens
// lands on the branch the designer drew".
//
// The three things that can be quietly wrong here, and are therefore what most
// of this is about:
//
//   1. the translation between a designer's { field, op, value } and the
//      expression node the engine evaluates — wrong, and a branch simply never
//      fires, which is not an error anywhere;
//   2. what a run reports it is parked on — wrong, and somebody is shown the
//      wrong screen;
//   3. tenancy — wrong, and one company submits another's run.

import http from 'node:http'
import express from 'express'
import { createRequire } from 'node:module'
import { runWithMt } from '@xeplr/db'
import actions from '@xeplr/actions'
import { makeFakeDb } from './fakeDb.mjs'

const require = createRequire(import.meta.url)

// BEFORE anything requires it. The engine's lib/flows.js and lib/workflowRunner.js both
// `require('./db')` at load time, and a class captured from the real one would
// try to reach a database that is not there.
const fakeDb = makeFakeDb()
const dbPath = require.resolve('@xeplr/workflow-engine/lib/db.js')
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb, children: [], paths: [] }

const flows = require('@xeplr/workflow-engine/lib/flows.js')
const workflowRunner = require('@xeplr/workflow-engine/lib/workflowRunner.js')
const buildFlowsRouter = require('../lib/flowsRouter.js')
const { refuseScreensEdit } = require('../lib/router.js')

// The one action every screen step names. Registered for real — the engine
// resolves a step's actionName through the registry and a step on an
// unregistered action fails before it can park.
actions.register(require('@xeplr/workflow-engine/lib/actions/screenShow.js'))

const results = []
const check = (name, cond) => { results.push([name, cond]); console.log((cond ? '  ok   ' : '  FAIL ') + name) }
const threw = (fn) => { try { fn(); return null } catch (e) { return e } }

// ── the app under test ──────────────────────────────────────────────────
//
// The same two things a host supplies: a tenant context per request (from the
// header its own mtMiddleware reads) and a membership gate. The gate refuses
// anybody without a user, so "every route is guarded" is checkable rather than
// asserted in a comment.
let gateCalls = 0
function gate(req, res, next) {
  gateCalls++
  if (!req.headers['x-user-id']) return res.status(403).json({ message: 'no' })
  next()
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  req.user = req.headers['x-user-id'] ? { id: req.headers['x-user-id'] } : null
  const company = req.headers['x-company-id']
  runWithMt(company ? { mtId1: company } : {}, next)
})
app.use('/flows', buildFlowsRouter({ mtMembershipGate: gate }))
// The workflow document's own save route, wired exactly as lib/router.js wires
// it: the refusal middleware first, the real handler behind it.
app.post('/workflows/save', refuseScreensEdit, (req, res) => res.json({ dataArray: [], updatedIds: ['saved'] }))

const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, resolve))
const base = 'http://127.0.0.1:' + server.address().port

async function call(method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-user-id': 'u1' },
      headers || {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// ────────────────────────────────────────────────────────────────────────
console.log('\nthe designer says a field name; the engine reads a path')
{
  // The browser never compiles an expression. This is the only place that
  // knows a resumed wait step's values land under `output`.
  const node = flows.whenToCondition({ field: 'type', op: '=', value: 'contractor' }, 'x')
  check('the field becomes the path the engine reads', node.left.field === 'output.type')
  check('the symbol becomes the operator the engine has', node.op === 'eq')
  check('the value is carried through as it was typed', node.right.value === 'contractor')

  check('null is the catch-all, not an error', flows.whenToCondition(null, 'x') === null)

  const alias = flows.whenToCondition({ field: 'age', op: 'gte', value: 18 }, 'x')
  check('the engine’s own spelling is accepted too', alias.op === 'gte' && alias.right.value === 18)

  const unary = flows.whenToCondition({ field: 'note', op: 'isEmpty' }, 'x')
  check('a one-sided comparison carries no right operand', unary.op === 'isNull' && unary.right === undefined)

  const list = flows.whenToCondition({ field: 'tier', op: 'in', value: ['gold', 'silver'] }, 'x')
  check('a set membership carries a list', Array.isArray(list.right.value) && list.right.value.length === 2)
}

console.log('\nwhat a designer may not send')
{
  // Every one of these would otherwise store a condition that never matches,
  // which is invisible: an unmatched branch is not an error, it is a path
  // nobody takes.
  check('an operator the engine does not have is refused',
    threw(() => flows.whenToCondition({ field: 'a', op: '~=', value: 1 }, 'x')) !== null)
  check('a path where a field name belongs is refused, not silently doubled',
    threw(() => flows.whenToCondition({ field: 'output.type', op: '=', value: 'x' }, 'x')) !== null)
  check('no field at all is refused',
    threw(() => flows.whenToCondition({ op: '=', value: 'x' }, 'x')) !== null)
  check('an object where a plain value belongs is refused',
    threw(() => flows.whenToCondition({ field: 'a', op: '=', value: { b: 1 } }, 'x')) !== null)
  check('a comparison with no value is refused',
    threw(() => flows.whenToCondition({ field: 'a', op: '=' }, 'x')) !== null)
  check('a one-sided comparison with a value is refused',
    threw(() => flows.whenToCondition({ field: 'a', op: 'isEmpty', value: 1 }, 'x')) !== null)
  check('"between" needs exactly two',
    threw(() => flows.whenToCondition({ field: 'a', op: 'between', value: [1] }, 'x')) !== null)
  const err = threw(() => flows.whenToCondition({ field: 'a', op: 'nope', value: 1 }, 'step "a"'))
  check('the refusal names the step and lists the comparisons that do exist',
    err.message.includes('step "a"') && err.message.includes('startsWith'))
}

console.log('\nand it comes back in the shape it was sent')
{
  const sent = { field: 'type', op: '=', value: 'contractor' }
  const back = flows.conditionToWhen(flows.whenToCondition(sent, 'x'))
  check('a branch round-trips without ever becoming text', JSON.stringify(back) === JSON.stringify(sent))
  const unary = { field: 'note', op: 'isEmpty' }
  check('...including a one-sided one',
    JSON.stringify(flows.conditionToWhen(flows.whenToCondition(unary, 'x'))) === JSON.stringify(unary))
  check('a catch-all stays a catch-all', flows.conditionToWhen(null) === null)
  // A condition this facade did not write has no `when` that describes it.
  // Reported as a catch-all rather than mistranslated into a branch.
  check('a hand-written condition is not guessed at',
    flows.conditionToWhen({ left: { field: 'params.tier' }, op: 'eq', right: { value: 'x' } }) === null)
}

// ────────────────────────────────────────────────────────────────────────
const STEPS = [
  {
    stepKey: 'person',
    label: 'About you',
    screen: 'person_form',
    layout: { x: 60, y: 100 },
    transitions: [
      { when: { field: 'type', op: '=', value: 'contractor' }, target: 'contract' },
      { when: null, target: 'payroll' }
    ]
  },
  { stepKey: 'contract', screen: 'contract_form', transitions: [{ when: null, target: 'end_success' }] },
  { stepKey: 'payroll', screen: 'payroll_form', transitions: [{ when: null, target: 'end_success' }] }
]

console.log('\ndesigning a flow')
{
  const created = await call('POST', '/flows', { key: 'onboard', name: 'Onboard' })
  check('creating one answers 201', created.status === 201)
  check('...as a draft', created.body.status === 'draft')
  check('...with no steps yet', created.body.steps === 0)
  check('...and an id of its own', typeof created.body.id === 'string' && created.body.id.length > 0)

  const dup = await call('POST', '/flows', { key: 'onboard', name: 'Again' })
  check('the same key twice is refused by name', dup.status === 409 && dup.body.code === 'FLOW_KEY_TAKEN')

  const reserved = await call('POST', '/flows', { key: 'runs', name: 'Runs' })
  check('a key that would shadow /flows/runs/:runId is refused',
    reserved.status === 400 && reserved.body.code === 'FLOW_KEY_INVALID')

  const listed = await call('GET', '/flows')
  check('the list is a plain array', Array.isArray(listed.body))
  check('...of one', listed.body.length === 1 && listed.body[0].key === 'onboard')
  check('...and `steps` there is a count', listed.body[0].steps === 0)

  const put = await call('PUT', '/flows/onboard', { steps: STEPS })
  check('the steps go in', put.status === 200 && put.body.steps.length === 3)

  const got = await call('GET', '/flows/onboard')
  check('a screen comes back on its step', got.body.steps[0].screen === 'person_form')
  check('layout is carried, untouched', got.body.steps[0].layout.x === 60)
  check('a branch comes back in the SAME `when` shape it was sent in',
    JSON.stringify(got.body.steps[0].transitions) === JSON.stringify(STEPS[0].transitions))
  check('a step with no layout says so rather than inventing one', got.body.steps[1].layout === null)
  check('a step keeps the name the designer gave it', got.body.steps[0].label === 'About you')
  check('...and one given none says so', got.body.steps[1].label === null)

  const early = await call('POST', '/flows/onboard/runs', {})
  check('a draft cannot be run', early.status === 409 && early.body.code === 'FLOW_NOT_PUBLISHED')

  const published = await call('POST', '/flows/onboard/publish', {})
  check('publishing answers with the published flow', published.status === 200 && published.body.status === 'published')

  const again = await call('PUT', '/flows/onboard', { steps: STEPS })
  check('a published flow cannot be edited', again.status === 409 && again.body.code === 'FLOW_PUBLISHED')
  check('...and the refusal says what to do instead', /new version/i.test(again.body.message))

  const republish = await call('POST', '/flows/onboard/publish', {})
  check('publishing twice is not an error', republish.status === 200)
}

console.log('\nwhat publishing refuses')
{
  // Checked against the rows PUT would actually write, so the rule is applied
  // to the same shape the engine will read rather than to the designer's.
  const problems = (steps) => flows.validateFlow(flows.toStepRows('w1', steps))
  const says = (steps, fragment) => problems(steps).some((p) => p.message.includes(fragment))

  check('a flow with no screens at all', problems([]).length === 1)
  check('a step with no screen chosen',
    says([{ stepKey: 'a', screen: '', transitions: [{ when: null, target: 'end_success' }] }], 'No screen'))
  check('a transition to a step that does not exist',
    says([{ stepKey: 'a', screen: 's', transitions: [{ when: null, target: 'ghost' }] }], 'not a step of this flow'))
  check('...but the two end sentinels are fine',
    problems([{ stepKey: 'a', screen: 's', transitions: [{ when: null, target: 'end_failed' }] }]).length === 0)
  check('two catch-alls on one step',
    says([{ stepKey: 'a', screen: 's', transitions: [{ when: null, target: 'end_success' }, { when: null, target: 'end_failed' }] }], 'catch-alls'))
  check('a catch-all that is not last, so nothing after it can run',
    says([{
      stepKey: 'a', screen: 's',
      transitions: [{ when: null, target: 'end_success' }, { when: { field: 'x', op: '=', value: 1 }, target: 'end_failed' }]
    }], 'not the last transition'))
  check('a step in the middle with no way out',
    says([
      { stepKey: 'a', screen: 's' },
      { stepKey: 'b', screen: 's', transitions: [{ when: null, target: 'end_success' }] }
    ], 'no next screen'))
  check('...while the LAST step with no transitions simply ends the run',
    problems([
      { stepKey: 'a', screen: 's', transitions: [{ when: null, target: 'b' }] },
      { stepKey: 'b', screen: 's' }
    ]).length === 0)
  check('a screen nothing leads to',
    says([
      { stepKey: 'a', screen: 's', transitions: [{ when: null, target: 'end_success' }] },
      { stepKey: 'orphan', screen: 's' }
    ], 'Nothing leads to this step'))
  check('a healthy flow has nothing to report', problems(STEPS).length === 0)

  // And the same rule over HTTP, so the wiring is checked and not just the
  // function.
  await call('POST', '/flows', { key: 'broken', name: 'Broken' })
  await call('PUT', '/flows/broken', { steps: [{ stepKey: 'a', screen: '', transitions: [{ when: null, target: 'nowhere' }] }] })
  const refused = await call('POST', '/flows/broken/publish', {})
  check('publishing a broken flow is refused', refused.status === 400 && refused.body.code === 'FLOW_INVALID')
  check('...naming every problem, not just the first', refused.body.details.length === 2)
  check('...each against the step it is about', refused.body.details.every((d) => d.stepKey === 'a'))
}

console.log('\ntwo steps that could not be stored at all')
{
  const dupKeys = await call('PUT', '/flows/broken', {
    steps: [{ stepKey: 'a', screen: 's' }, { stepKey: 'a', screen: 't' }]
  })
  check('two steps sharing a stepKey are refused at PUT', dupKeys.status === 400)
  const badWhen = await call('PUT', '/flows/broken', {
    steps: [{ stepKey: 'a', screen: 's', transitions: [{ when: { field: 'x', op: '~', value: 1 }, target: 'end_success' }] }]
  })
  check('an impossible comparison is refused at PUT, not at run time', badWhen.status === 400)
  const stillThere = await call('GET', '/flows/broken')
  check('and a refused PUT leaves the draft as it was',
    stillThere.body.steps.length === 1 && stillThere.body.steps[0].stepKey === 'a')
}

// ────────────────────────────────────────────────────────────────────────
console.log('\nrunning it: the branch')
let branchRunId = null
{
  const started = await call('POST', '/flows/onboard/runs', {})
  branchRunId = started.body.runId
  check('starting a run answers 201', started.status === 201)
  check('...parked on the first step', started.body.stepKey === 'person')
  check('...naming the screen to show', started.body.screen === 'person_form')
  check('...and saying it is waiting', started.body.status === 'waiting')

  const reopened = await call('GET', '/flows/runs/' + branchRunId)
  check('a run can be reopened and reports the same step', reopened.body.stepKey === 'person')
  check('...with nothing filled in yet', JSON.stringify(reopened.body.values) === '{}')

  const submitted = await call('POST', '/flows/runs/' + branchRunId + '/submit', {
    values: { type: 'contractor', name: 'Ada' },
    recordId: 'rec_7'
  })
  check('submitting moves the run on', submitted.status === 200)
  check('...to the branch the value chose', submitted.body.stepKey === 'contract')
  check('...and says which screen that is', submitted.body.screen === 'contract_form')
  check('...still waiting, not done', submitted.body.status === 'waiting')

  // The app wrote the record into its own table; the run keeps the handle so a
  // later step or condition can point at it.
  const personRun = fakeDb.store.WorkflowStepRun.find((sr) => sr.runId === branchRunId && sr.stepKey === 'person')
  check('recordId is kept on the step’s output', personRun.output.recordId === 'rec_7')
  check('...beside the submitted values, which are the output',
    personRun.output.type === 'contractor' && personRun.output.name === 'Ada')
  check('...and the step run records which screen was shown', personRun.input.screen === 'person_form')

  const inProgress = await call('GET', '/flows/onboard/runs?mine=1')
  check('an unfinished run shows up as in progress', inProgress.body.length === 1)
  check('...saying where it is', inProgress.body[0].stepKey === 'contract' && inProgress.body[0].screen === 'contract_form')
  check('...and which run it is', inProgress.body[0].runId === branchRunId)

  const finished = await call('POST', '/flows/runs/' + branchRunId + '/submit', { values: { signed: true } })
  check('the last screen ends the run', finished.body.status === 'done')
  check('...with no next screen to show', finished.body.stepKey === null && finished.body.screen === null)

  const after = await call('GET', '/flows/runs/' + branchRunId)
  check('and it stays done', after.body.status === 'done')

  const closed = await call('POST', '/flows/runs/' + branchRunId + '/submit', { values: {} })
  check('a finished run cannot be submitted again', closed.status === 409 && closed.body.code === 'RUN_NOT_WAITING')

  const gone = await call('GET', '/flows/onboard/runs?mine=1')
  check('and it is no longer in progress', gone.body.length === 0)
}

console.log('\nrunning it: the catch-all')
{
  const started = await call('POST', '/flows/onboard/runs', {})
  const submitted = await call('POST', '/flows/runs/' + started.body.runId + '/submit', { values: { type: 'employee' } })
  check('a value no branch names falls to the catch-all', submitted.body.stepKey === 'payroll')
  check('...and that screen is what comes back', submitted.body.screen === 'payroll_form')

  const done = await call('POST', '/flows/runs/' + started.body.runId + '/submit', { values: {} })
  check('which also ends', done.body.status === 'done')
}

console.log('\none company never sees another’s runs')
{
  const other = { 'x-company-id': 'c2', 'x-user-id': 'u2' }

  const theirFlows = await call('GET', '/flows', undefined, other)
  check('another company’s flow list is empty', theirFlows.body.length === 0)

  const theirRead = await call('GET', '/flows/onboard', undefined, other)
  check('...and the flow itself is simply not there', theirRead.status === 404)

  const theirRun = await call('GET', '/flows/runs/' + branchRunId, undefined, other)
  check('a run id from elsewhere is not found, not refused', theirRun.status === 404)

  const theirSubmit = await call('POST', '/flows/runs/' + branchRunId + '/submit', { values: { x: 1 } }, other)
  check('...and it cannot be submitted either', theirSubmit.status === 404)

  // The same key is a different flow under a different company — a word one
  // tenant uses must not be taken from everybody else.
  const theirs = await call('POST', '/flows', { key: 'onboard', name: 'Theirs' }, other)
  check('the same key under another company is a different flow', theirs.status === 201)

  const mineStill = await call('GET', '/flows/onboard')
  check('...and mine is untouched', mineStill.body.name === 'Onboard')
}

console.log('\nevery route is gated')
{
  const before = gateCalls
  const anon = await call('GET', '/flows', undefined, { 'x-user-id': '' })
  check('an unauthenticated request is refused', anon.status === 403)
  check('...by the host’s own gate, not by this router', gateCalls > before)

  const anonSubmit = await call('POST', '/flows/runs/' + branchRunId + '/submit', { values: {} }, { 'x-user-id': '' })
  check('submitting is gated too — the browser never holds a resume key', anonSubmit.status === 403)
}

console.log('\nthe workflow document refuses a flow')
{
  const flow = (await call('GET', '/flows/onboard')).body

  const byId = await fetch(base + '/workflows/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-user-id': 'u1' },
    body: JSON.stringify([{ id: flow.id, name: 'Renamed' }])
  })
  const byIdBody = await byId.json()
  check('saving a flow through the workflow routes is refused', byId.status === 400)
  check('...with the sentence that says where it IS editable',
    byIdBody.message === flows.SCREENS_EDIT_MESSAGE)
  check('...and a code a client can branch on', byIdBody.code === 'FLOW_READ_ONLY')

  const byKind = await fetch(base + '/workflows/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-user-id': 'u1' },
    body: JSON.stringify([{ name: 'New', kind: 'screens' }])
  })
  check('creating one there is refused too', byKind.status === 400)

  const ordinary = await fetch(base + '/workflows/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': 'c1', 'x-user-id': 'u1' },
    body: JSON.stringify([{ name: 'An ordinary workflow' }])
  })
  check('an ordinary workflow still saves', ordinary.status === 200)
}

console.log('\nthings that are simply not there')
{
  const noFlow = await call('GET', '/flows/nope')
  check('an unknown flow is a 404 with a code', noFlow.status === 404 && noFlow.body.code === 'FLOW_NOT_FOUND')
  const noRun = await call('GET', '/flows/runs/nope')
  check('an unknown run is a 404 with a code', noRun.status === 404 && noRun.body.code === 'RUN_NOT_FOUND')
  const badValues = await call('POST', '/flows/runs/' + branchRunId + '/submit', { values: [1, 2] })
  check('`values` that is not an object is refused', badValues.status === 400)
}

// ────────────────────────────────────────────────────────────────────────
// A SCREEN INSIDE AN ORDINARY WORKFLOW.
//
// The designer offers Screen beside Action and Condition, so a screen is no
// longer something only a flow-of-screens can hold. It used to be a trap: the
// engine parked the run correctly — a screen step is a wait step like any
// other — but the two routes that show and resume one answered 404 unless the
// whole workflow was kind 'screens'. A step that can be drawn and can never
// be finished is worse than one that cannot be drawn.
console.log('\na screen in an ordinary workflow')
{
  // Seeded directly: /flows/:key/runs starts FLOWS, and the point here is a
  // workflow that is not one.
  await runWithMt({ mtId1: 'c1' }, async () => {
    await fakeDb.model('Workflow').query().insert({
      id: 'wf_mixed', name: 'Mixed', kind: 'workflow', status: 'published'
    })
    await fakeDb.model('WorkflowStep').query().insert({
      id: 'st_ask', workflowId: 'wf_mixed', stepKey: 'ask', name: 'Ask the manager',
      actionName: 'screen-show', kind: 'wait', onError: 'stop',
      values: { screen: 'approval_form' }, position: 0, transitions: null
    })
  })

  const run = await runWithMt({ mtId1: 'c1' }, () => workflowRunner.startRun('wf_mixed', {}, { user: { id: 'u1' } }))

  const seen = await call('GET', '/flows/runs/' + run.id)
  check('the run can be opened, though its workflow is not a flow', seen.status === 200)
  check('...and says which screen it is parked on', seen.body.screen === 'approval_form')

  const done = await call('POST', '/flows/runs/' + run.id + '/submit', { values: { approved: true } })
  check('submitting it works — the trap is closed', done.status === 200)
  check('...and the run moves on', done.body.status === 'Completed' || done.body.status !== 'waiting')

  const stepRun = fakeDb.store.WorkflowStepRun.find((sr) => sr.runId === run.id && sr.stepKey === 'ask')
  check('...with what the person typed as the step output', stepRun && stepRun.output && stepRun.output.approved === true)
}

console.log('\na flow the designer drew, run by the same page')
{
  // What a flow MEANS has widened: not only "kind screens, designed
  // elsewhere" but an ordinary workflow drawn in the designer, addressed by
  // the key its app gave it. The page that starts and resumes one must not
  // care which it is looking at.
  await runWithMt({ mtId1: 'c1' }, async () => {
    await fakeDb.model('Workflow').query().insert({
      id: 'wf_drawn', key: 'drawn', name: 'Drawn here', kind: 'workflow', status: 'draft'
    })
    await fakeDb.model('WorkflowStep').query().insert({
      id: 'st_form', workflowId: 'wf_drawn', stepKey: 'form', name: 'Fill it in',
      actionName: 'screen-show', kind: 'wait', onError: 'stop',
      values: { screen: 'intake_form' }, position: 0, transitions: null
    })
  })

  const started = await call('POST', '/flows/drawn/runs', {})
  check('it starts by key, like any flow', started.status === 201)
  check('...parked on its first screen', started.body.screen === 'intake_form')

  // A draft is refused for a SCREENS flow, where publish is what checks the
  // design. A drawn one has no publish step anywhere, so demanding one would
  // make every flow this app draws unrunnable.
  check('a draft drawn here still runs', started.body.status === 'waiting')

  const mine = await call('GET', '/flows/drawn/runs?mine=1')
  check('its runs are listed by key too', mine.status === 200 && mine.body.length === 1)

  const done = await call('POST', '/flows/runs/' + started.body.runId + '/submit', { values: { name: 'Ada' } })
  check('and it is submitted the same way', done.status === 200)
}

console.log('\ndesigning one is still not the same as running one')
{
  // putFlow and publishFlow generate step rows from a screens-only
  // description. Pointed at a workflow drawn in the designer they would
  // delete a design they cannot express, so they stay kind-gated.
  const put = await call('PUT', '/flows/drawn', { steps: [{ stepKey: 'a', screen: 's' }] })
  check('PUT does not touch a workflow drawn in the designer', put.status === 404)
  const pub = await call('POST', '/flows/drawn/publish', {})
  check('neither does publish', pub.status === 404)
  const seen = await call('GET', '/flows/drawn')
  check('nor does the screens-shaped read', seen.status === 404)
}

console.log('\nwhat the flow already knows, handed to the screen')
{
  // A containment belongs to a complaint. The flow has the complaint's id —
  // the record D1 saved — and the person filling in D3 must never be asked to
  // type a twenty-five character id. So the step carries it as an input, the
  // engine resolves it like any other, and the facade hands it over with the
  // screen.
  await runWithMt({ mtId1: 'c1' }, async () => {
    await fakeDb.model('Workflow').query().insert({
      id: 'wf_8d', key: 'eight_d', name: 'Complaint', kind: 'workflow', status: 'published'
    })
    await fakeDb.model('WorkflowStep').query().insert({
      id: 'st_d1', workflowId: 'wf_8d', stepKey: 'd1', name: 'Raise the complaint',
      actionName: 'screen-show', kind: 'wait', onError: 'stop',
      values: { screen: 'complaint_edit' }, position: 0,
      transitions: [{ target: 'd3' }]
    })
    await fakeDb.model('WorkflowStep').query().insert({
      id: 'st_d3', workflowId: 'wf_8d', stepKey: 'd3', name: 'Contain it',
      actionName: 'screen-show', kind: 'wait', onError: 'stop',
      values: { screen: 'containment_edit', values: { complaintId: '{steps.d1.output.recordId}' } },
      position: 1, transitions: null
    })
  })

  const started = await call('POST', '/flows/eight_d/runs', {})
  check('the first screen is asked for nothing', JSON.stringify(started.body.given) === '{}')

  const next = await call('POST', '/flows/runs/' + started.body.runId + '/submit', {
    values: { title: 'Leaking valve' }, recordId: 'cmp_1042'
  })
  check('the flow moves to the step that needs it', next.body.stepKey === 'd3')
  check('...and hands the screen what it already knows', next.body.given.complaintId === 'cmp_1042')

  // Resolved by the ENGINE, against the run — a browser has nothing to
  // substitute a token with, so a token reaching it would be saved as text.
  check('the token is gone by the time it leaves the server',
    !/\{steps\./.test(JSON.stringify(next.body.given)))

  const reopened = await call('GET', '/flows/runs/' + started.body.runId)
  check('and it is still there when the run is reopened', reopened.body.given.complaintId === 'cmp_1042')
}

console.log('\nwaiting is not the same as waiting for a PERSON')
{
  // Now that any run reaches this route, a step parked on something that is
  // not a screen — an email that has not arrived, a callback nobody has made
  // — is one POST away from being answered by whoever happens to be looking
  // at the run. It is resumed by what it is waiting FOR, through the engine's
  // own key, and not by a browser.
  //
  // A real wait step, registered like any other action, rather than a screen
  // step edited afterwards: the engine resolves the action while it parks, so
  // changing it underneath is a race and not a test.
  actions.register({
    name: 'await-reply',
    description: 'Parks until the reply arrives.',
    requires: [],
    inputSchema: [],
    execute: async function () { return {} }
  })

  await runWithMt({ mtId1: 'c1' }, async () => {
    await fakeDb.model('Workflow').query().insert({
      id: 'wf_wait', name: 'Waits', kind: 'workflow', status: 'published'
    })
    await fakeDb.model('WorkflowStep').query().insert({
      id: 'st_mail', workflowId: 'wf_wait', stepKey: 'mail', name: 'Wait for the reply',
      actionName: 'await-reply', kind: 'wait', onError: 'stop',
      values: {}, position: 0, transitions: null
    })
  })
  const run = await runWithMt({ mtId1: 'c1' }, () => workflowRunner.startRun('wf_wait', {}, { user: { id: 'u1' } }))
  check('it parks, like any wait step', run.status === 'waiting')

  const seen = await call('GET', '/flows/runs/' + run.id)
  check('the run can still be read — there is no screen to show', seen.status === 200 && seen.body.screen === null)

  const refused = await call('POST', '/flows/runs/' + run.id + '/submit', { values: { approved: true } })
  check('a browser cannot answer what the world is supposed to answer',
    refused.status === 409 && refused.body.code === 'NOT_A_SCREEN')
  check('...and says which step, by the name the designer gave it',
    /Wait for the reply/.test(refused.body.message))
}

console.log('\nletting a function decide')
{
  // The developer's function, registered for the `decide` event. It reads
  // what was filled in and names the next step.
  actions.register({
    name: 'routeByAmount', event: 'decide', description: 'Large requests go to review',
    execute: (ctx) => (Number(ctx.values.amount) > 1000 ? 'review' : 'done_screen')
  })
  actions.register({ name: 'wanders', event: 'decide', execute: () => 'nowhere' })
  actions.register({ name: 'notADecider', event: 'beforeSave', execute: () => 'review' })

  const DECIDED = [
    { stepKey: 'request', screen: 'request_form', transitions: [{ decide: 'routeByAmount', targets: ['review', 'done_screen'] }] },
    { stepKey: 'review', screen: 'review_form', transitions: [{ when: null, target: 'end_success' }] },
    { stepKey: 'done_screen', screen: 'thanks_form', transitions: [{ when: null, target: 'end_success' }] }
  ]
  await call('POST', '/flows', { key: 'spend', name: 'Spend' })
  const put = await call('PUT', '/flows/spend', { steps: DECIDED })
  check('an arrow may name a function instead of a target', put.status === 200)
  const got = await call('GET', '/flows/spend')
  check('...and comes back as the function and the steps it may choose',
    JSON.stringify(got.body.steps[0].transitions) === JSON.stringify([{ when: null, decide: 'routeByAmount', targets: ['review', 'done_screen'] }]))
  check('both steps it may choose count as reachable — publishing is allowed',
    (await call('POST', '/flows/spend/publish', {})).status === 200)

  const big = await call('POST', '/flows/spend/runs', {})
  const toReview = await call('POST', '/flows/runs/' + big.body.runId + '/submit', { values: { amount: 5000 } })
  check('the function chose review for a large amount', toReview.body.stepKey === 'review' && toReview.body.screen === 'review_form')
  const small = await call('POST', '/flows/spend/runs', {})
  const toDone = await call('POST', '/flows/runs/' + small.body.runId + '/submit', { values: { amount: 20 } })
  check('...and the thanks screen for a small one', toDone.body.stepKey === 'done_screen')

  const bad = (key, decide, targets) => [
    { stepKey: 'a', screen: 'a_form', transitions: [{ decide, targets }] },
    { stepKey: 'b', screen: 'b_form', transitions: [{ when: null, target: 'end_success' }] }
  ]
  await call('POST', '/flows', { key: 'missing_fn', name: 'Missing' })
  await call('PUT', '/flows/missing_fn', { steps: bad('missing_fn', 'noSuchFunction', ['b']) })
  const missing = await call('POST', '/flows/missing_fn/publish', {})
  check('a function nobody registered is refused at publish, by name',
    missing.status === 400 && missing.body.details.some((d) => d.message.includes('"noSuchFunction" decide, but no function of that name is registered')))
  await call('POST', '/flows', { key: 'wrong_event', name: 'Wrong' })
  await call('PUT', '/flows/wrong_event', { steps: bad('wrong_event', 'notADecider', ['b']) })
  const wrong = await call('POST', '/flows/wrong_event/publish', {})
  check('...and so is one written for another event', wrong.status === 400 && JSON.stringify(wrong.body).includes('written for \\"beforeSave\\"'))
  await call('POST', '/flows', { key: 'bad_target', name: 'Bad' })
  await call('PUT', '/flows/bad_target', { steps: bad('bad_target', 'routeByAmount', ['b', 'ghost']) })
  const ghost = await call('POST', '/flows/bad_target/publish', {})
  check('...and a step it may choose that is not in the flow', ghost.status === 400 && JSON.stringify(ghost.body).includes('may choose \\"ghost\\"'))

  await call('POST', '/flows', { key: 'wander', name: 'Wander' })
  await call('PUT', '/flows/wander', { steps: bad('wander', 'wanders', []) })
  check('with no targets listed, any step of the flow is reachable', (await call('POST', '/flows/wander/publish', {})).status === 200)
  const w = await call('POST', '/flows/wander/runs', {})
  const lost = await call('POST', '/flows/runs/' + w.body.runId + '/submit', { values: {} })
  check('an answer that is not a step fails the run, saying what it chose',
    lost.body.status === 'failed' && JSON.stringify(lost.body).includes('chose \\"nowhere\\"'))
}

server.close()

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
