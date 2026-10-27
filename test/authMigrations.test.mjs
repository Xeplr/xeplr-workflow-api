// The access rows this package adds to an auth database, applied for real:
// @xeplr/auth's own migrations, then migrations-auth/ on top, on a scratch
// Postgres — as the auth server applies them through XEPLR_AUTH_MIGRATIONS.
// Every workflow route row has a group and reaches a role besides Super
// Admin (one that does not is refused to everyone else, and nobody finds out
// until a screen stops working); the admin routes reach only the admins; and
// running every file again changes nothing.
//
// Needs WORKFLOW_TEST_PG = '{"host":"localhost","port":5432,"user":"…","password":"…"}'.
import { createRequire } from 'node:module'
import path from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

const PG = process.env.WORKFLOW_TEST_PG ? JSON.parse(process.env.WORKFLOW_TEST_PG) : null
if (!PG) {
  console.log('  skipped — set WORKFLOW_TEST_PG to run against Postgres')
  process.exit(0)
}

const { resolveConfig, ensureDatabaseFor, sqlMigrator } = require('@xeplr/db')
const { Client } = require('pg')

const results = []
const check = (n, c, extra) => { results.push(c); console.log((c ? '  ok   ' : '  FAIL ') + n + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 600))) }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OURS = path.join(HERE, '..', 'migrations-auth')
const AUTHS = path.join(path.dirname(require.resolve('@xeplr/auth/package.json')), 'migrations')
const DB = 'xeplr_wf_auth_rows_test_' + Date.now()

// The first Super Admin auth seeds: a throwaway one, for a scratch database.
process.env.AUTH_SUPER_ADMIN_EMAIL = process.env.AUTH_SUPER_ADMIN_EMAIL || 'admin@workflow.test'
process.env.AUTH_SUPER_ADMIN_PASSWORD = process.env.AUTH_SUPER_ADMIN_PASSWORD || 'scratch-only-' + Date.now()

const client = new Client({ ...PG, database: DB })
try {
  await ensureDatabaseFor(PG, DB)
  await resolveConfig('WORKFLOW_AUTH_ROWS_TEST', PG)
  await sqlMigrator.up({ db: DB, dir: AUTHS, extDir: OURS, type: 'precede', connectionName: 'workflow_auth_rows_test' })
  await client.connect()
  check('auth\'s migrations and this package\'s apply cleanly, in order', true)

  const rows = (await client.query(`
    SELECT a.name, a."apiGroup", a."isPublic", array_remove(array_agg(r.name), NULL) AS roles
    FROM apis a
    LEFT JOIN "apisRolesMapping" m ON m."apiId" = a.id
    LEFT JOIN roles r ON r.id = m."roleId"
    WHERE a."apiGroup" LIKE 'workflows:%'
    GROUP BY a.name, a."apiGroup", a."isPublic"`)).rows
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  const orphans = rows.filter((r) => !r.isPublic && !r.roles.some((n) => n !== 'Super Admin'))
  check('every workflow route row reaches a role besides Super Admin', orphans.length === 0, orphans.map((r) => r.name))

  const has = (api, role) => byName[api] && byName[api].roles.includes(role)
  check('the inbox and answering reach every role, Viewer too',
    ['List my tasks', 'Take task', 'Put task back', 'Answer task'].every((a) => ['Super Admin', 'CompanyAdmin', 'Creator', 'Viewer'].every((r) => has(a, r))),
    ['List my tasks', 'Answer task'].map((a) => byName[a]))
  check('the admin actions reach Super Admin and the company admin only',
    ['Reassign task', 'Cancel run', 'Retry run'].every((a) => has(a, 'Super Admin') && has(a, 'CompanyAdmin') && !has(a, 'Creator') && !has(a, 'Viewer')),
    ['Reassign task', 'Cancel run', 'Retry run'].map((a) => byName[a]))
  check('...in their own group, workflows:admin', ['Reassign task', 'Cancel run', 'Retry run'].every((a) => byName[a].apiGroup === 'workflows:admin'))

  const count = async () => (await client.query('SELECT (SELECT count(*) FROM apis) + (SELECT count(*) FROM "apisRolesMapping") AS n')).rows[0].n
  const before = await count()
  for (const f of readdirSync(OURS).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(readFileSync(path.join(OURS, f), 'utf8'))
  }
  check('running every file again adds nothing', (await count()) === before)
} catch (err) {
  check('no error', false, err.stack || err.message)
} finally {
  await client.end().catch(() => {})
  const admin = new Client({ ...PG, database: 'postgres' })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {})
  await admin.end()
  const failed = results.filter((c) => !c).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
