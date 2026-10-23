// A STAND-IN FOR lib/db.js, so the engine and the flows facade can be driven
// end to end without a database.
//
// Not a mock of the facade's own calls — that would only ever prove the facade
// calls what the test says it calls. This is an in-memory table store with
// enough of Objection's query builder for workflowRunner.js to run UNCHANGED
// against it: the real engine starts the run, mints the resume key, parks on
// the wait step, evaluates the real transitions with @xeplr/expression-handler
// and routes. What the suite beside this checks is therefore the actual
// behaviour of the actual engine, with only the storage swapped.
//
// It keeps the two rules of BaseModel that the tests are ABOUT:
//
//   • an insert is stamped with the ambient tenant (runWithMt), and refuses
//     without one;
//   • query() sees only the current tenant's rows and unscopedQuery() sees
//     every tenant's — which is what makes "one company cannot see another's
//     runs" a thing this suite can actually assert rather than assume.
//
// Rows are cloned on the way out, so a caller holding one cannot reach into
// the store through it — the same isolation a row fetched over a connection
// has, and the absence of it hides real bugs.

import { getMtContext } from '@xeplr/db'

const TABLES = [
  'Company', 'Workspace', 'Workflow', 'WorkflowStep',
  'WorkflowRun', 'WorkflowStepRun', 'WorkflowResumeKey', 'WorkflowRunEdge'
]

function clone(row) {
  return row === undefined || row === null ? row : JSON.parse(JSON.stringify(row))
}

function matches(row, filters) {
  return filters.every((f) => {
    if (f.kind === 'in') return f.values.includes(row[f.column])
    // A column nobody wrote reads as NULL, not as absent — which is the whole
    // of `where consumedDate is null`, the query the resume mechanism is built
    // on. Treating an unset property as "no match" made a freshly minted key
    // unfindable, which is a fact about this fake and not about the engine.
    return Object.keys(f.where).every((k) => {
      const have = row[k] === undefined ? null : row[k]
      return have === f.where[k]
    })
  })
}

export function makeFakeDb() {
  const store = {}
  TABLES.forEach((t) => { store[t] = [] })
  // Monotonic, because recordCreatedDate is what the engine orders step runs
  // by and two inserts inside one millisecond would otherwise tie — which in
  // buildContext means "previous_step" becomes whichever the sort happened to
  // put last.
  let seq = 0

  function query(table, { scoped }) {
    const filters = []
    let order = null
    let single = false
    let op = null
    let payload = null

    const builder = {
      where(a, b) {
        filters.push({ kind: 'eq', where: typeof a === 'string' ? { [a]: b } : a })
        return builder
      },
      whereIn(column, values) {
        filters.push({ kind: 'in', column, values })
        return builder
      },
      orderBy(column, direction) { order = { column, direction: direction || 'asc' }; return builder },
      select() { return builder },
      limit() { return builder },
      findById(id) { filters.push({ kind: 'eq', where: { id } }); single = true; return builder },
      first() { single = true; return builder },
      insert(row) { op = 'insert'; payload = row; return builder },
      patch(row) { op = 'patch'; payload = row; return builder },
      delete() { op = 'delete'; return builder },

      // A REAL promise, not a bare thenable: Objection's builder is one, so
      // code written against it chains .then().catch() and a thenable that
      // returns undefined breaks at the .catch rather than at the query.
      then(onFulfilled, onRejected) { return settle().then(onFulfilled, onRejected) },
      catch(onRejected) { return settle().catch(onRejected) },
      finally(fn) { return settle().finally(fn) }
    }

    function settle() {
      try { return Promise.resolve(run()) } catch (err) { return Promise.reject(err) }
    }

    function visible() {
      const ctx = getMtContext()
      return store[table].filter((row) => {
        if (row.isActive === false) return false
        if (scoped) {
          if (!ctx.mtId1) return false
          if (row.mtId1 !== ctx.mtId1 && row.mtId1 !== '*') return false
        }
        return matches(row, filters)
      })
    }

    function run() {
      if (op === 'insert') {
        const ctx = getMtContext()
        const mtId1 = payload.mtId1 || ctx.mtId1
        if (!mtId1) throw new Error('Tenant context (mtId1) is required to insert into "' + table + '"')
        seq += 1
        const row = Object.assign({
          isActive: true,
          mtId1,
          recordCreatedDate: new Date(1700000000000 + seq).toISOString(),
          recordModifiedDate: new Date(1700000000000 + seq).toISOString()
        }, payload, { mtId1 })
        store[table].push(row)
        return clone(row)
      }

      const rows = visible()

      if (op === 'patch') {
        rows.forEach((row) => Object.assign(row, payload))
        return rows.length
      }
      if (op === 'delete') {
        rows.forEach((row) => { store[table].splice(store[table].indexOf(row), 1) })
        return rows.length
      }

      let out = rows.slice()
      if (order) {
        out.sort((a, b) => {
          const x = a[order.column]
          const y = b[order.column]
          if (x === y) return 0
          return (x > y ? 1 : -1) * (order.direction === 'desc' ? -1 : 1)
        })
      }
      return single ? clone(out[0]) : out.map(clone)
    }

    return builder
  }

  const db = function connectDb() { throw new Error('fakeDb: connectDb is not used in tests') }
  db.conn = () => { throw new Error('fakeDb: conn is not used in tests') }
  db.model = (name) => {
    if (!store[name]) throw new Error('fakeDb: unknown model "' + name + '"')
    return {
      query: () => query(name, { scoped: true }),
      unscopedQuery: () => query(name, { scoped: false })
    }
  }
  // The raw tables, for the handful of assertions that are about what was
  // WRITTEN rather than about what a route answered.
  db.store = store
  return db
}
