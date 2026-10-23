// With `access: true`, every flows route answers only a caller whose
// permissions name it — and refuses outright when no auth gate ran.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const express = require('express')
const buildFlowsRouter = require('../lib/flowsRouter')

const results = []
const check = (n, c) => { results.push([n, c]); console.log((c ? '  ok   ' : '  FAIL ') + n) }

async function serve(access, withAccess) {
  const app = express()
  app.use(express.json())
  if (withAccess !== undefined) app.use((req, res, next) => { req.access = withAccess; next() })
  app.use('/flows', buildFlowsRouter({ access }))
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  return { base: `http://127.0.0.1:${server.address().port}/flows`, close: () => server.close() }
}

const { API_NAMES } = buildFlowsRouter
check('every route has a permission name', Object.keys(API_NAMES).length === 9)

console.log('\naccess: true')
{
  const none = await serve(true)
  const r1 = await fetch(none.base)
  check('no req.access at all → 403 (fails closed)', r1.status === 403 && (await r1.json()).code === 'NO_ACCESS_INFO')
  none.close()

  const viewer = await serve(true, { apis: ['List flows'] })
  const r2 = await fetch(viewer.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"x","name":"X"}' })
  check('a permission the caller lacks → 403 naming it', r2.status === 403 && /Create flow/.test((await r2.json()).message))
  const r3 = await fetch(viewer.base + '/k/runs', { method: 'POST' })
  check('starting a run needs "Start flow run"', r3.status === 403)
  const r4 = await fetch(viewer.base)
  check('a permission the caller has → past the check', r4.status !== 403)
  viewer.close()
}

console.log('\naccess off (the default, as before)')
{
  const open = await serve(false)
  const r = await fetch(open.base)
  check('no permission check', r.status !== 403)
  open.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
