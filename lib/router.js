var express = require('express');
var { genericRoute } = require('@xeplr/base-apis');
// Both used ONLY by the builder's try-run route below, and both are the same
// calls the engine itself makes (see workflowRunner) — deliberately, so a
// try-run resolves references and validates input exactly the way a real run
// would, rather than approximating it.
var { runAction } = require('@xeplr/actions');
var { interpolateAll } = require('@xeplr/schema-handler');
var engine = require('@xeplr/workflow-engine');
var db = engine.db;
var actionCatalog = engine.actionCatalog;
var workflowRunner = engine.runner;
var flows = engine.flows;
var buildFlowsRouter = require('./flowsRouter');
var triggers = engine.triggers;
var { exposedEnv } = engine.envExposed;

function noop(req, res, next) { next(); }

/**
 * Build the workflow HTTP router. Pure config in, Express Router out —
 * NEVER reads process.env FOR ITS CONFIGURATION and never requires
 * @xeplr/auth directly, so the exact same router works whether
 * orchestration/standalone.js built it for a solo process, or a host app's
 * own registerWorkflow() call built it to mount into itself.
 *
 * The one process.env touch is inside the try-run handler: exposedEnv()
 * resolves `{env.NAME}` bindings, and it is deliberately NOT lifted up here
 * into config. It is per-request runtime DATA, identical embedded and
 * standalone, and reading it at build time would freeze whatever the
 * environment happened to be when the router was constructed. The invariant
 * this comment protects is that no BEHAVIOUR differs between the two mounts,
 * and that still holds.
 *
 * @param {object} [config]
 * @param {Function} [config.mtMembershipGate] - middleware checking THIS
 *   product's own apis/menus grants (see
 *   migrations-auth/0001_workflow_access.sql). Distinct from basic
 *   authentication — by the time a request reaches here, something upstream
 *   (a host app's own middleware, or this package's own standalone
 *   orchestration) has already established WHO the request is from; this
 *   checks whether that identity is allowed to hit THIS specific route.
 *   Omit to leave every route ungated — fine for local, unauthenticated dev
 *   use, never for anything actually reachable by anyone else.
 * @param {Function} [config.authMiddleware] - populates req.user; used only
 *   by GET /me as an "is auth actually wired" smoke check.
 * @returns {import('express').Router}
 */
function buildWorkflowRouter(config) {
  config = config || {};
  var gate = config.mtMembershipGate || noop;
  var router = express.Router();

  // BOUND to workflow's own connection, and resolved HERE rather than at
  // require time — connectDb has run by the time registerWorkflow calls this,
  // and a class captured before it would carry the process's global binding
  // instead. See lib/db.js's model().
  var Company = db.model('Company');
  var Workspace = db.model('Workspace');
  var Workflow = db.model('Workflow');
  var WorkflowStep = db.model('WorkflowStep');

  router.get('/', function(req, res) {
    res.json({ service: 'api', status: 'running', name: 'xeplr-workflow-api' });
  });

  if (config.authMiddleware) {
    router.get('/me', config.authMiddleware, function(req, res) {
      res.json({ id: req.user.id, email: req.user.email, name: req.user.name, roles: req.user.roles || [] });
    });
  }

  // ── the action catalog ───────────────────────────────────────────────────
  //
  // Served from the registry itself rather than from a list kept beside it —
  // a step editor's form is generated from these schemas, so a second
  // description of an action is a second thing to keep in step.
  router.get('/actions', gate, function(req, res) {
    res.json({ dataArray: actionCatalog.catalog() });
  });

  // ── tenancy ──────────────────────────────────────────────────────────────
  //
  // NO gate on /companies — Company opted out at the model level
  // (multiTenant = false), and gating it would 403 the "pick a company"
  // screen whenever a header is present but not yet authorized.
  router.use('/companies', genericRoute({ key: 'company', model: Company }));
  router.use('/workspaces', gate, genericRoute({ key: 'workspace', model: Workspace }));

  // ── the workflow document ───────────────────────────────────────────────
  //
  // One POST /workflows/save writes the workflow and its whole step list in
  // one transaction. GET /workflows/:id comes back with `steps` eager-loaded.
  //
  // BEFORE the genericRoute mount, and only on /save: a workflow of kind
  // 'screens' is GENERATED from a design held in another app (see lib/flows.js
  // and the /flows mount below), so an edit made here survives only until the
  // next PUT /flows/:key and then disappears without a record. Reading one is
  // untouched and so is deleting one — runs and history stay visible, and a
  // flow nobody wants any more must still be removable from the list it is in.
  // ── BY THE NAME A HOST CALLS IT ─────────────────────────────────────────
  //
  // `workflows.key` (0013) exists so an app can address a flow by a stable
  // name of its own choosing — "pool" — rather than by the id this database
  // happened to mint. Its own pages then have readable, durable URLs, and a
  // link somebody saved survives a rebuild that mints new ids.
  //
  // Without this route the key was only addressable through /flows, which
  // answers for kind 'screens' alone — so a host with key-shaped URLs had
  // nowhere to ask "which workflow is this?" and passed the key where an id
  // was expected, which is a 404 that looks like a missing flow rather than
  // like a lookup by the wrong thing.
  //
  // BEFORE the generic mount, or /workflows/:id would claim it and look for a
  // workflow whose id is the literal string "by-key".
  router.get('/workflows/by-key/:key', gate, async function(req, res) {
    var row = await Workflow.query()
      .where({ key: req.params.key })
      .withGraphFetched('steps')
      .first();
    if (!row) {
      return res.status(404).json({ status: 'error', message: 'No workflow with key "' + req.params.key + '".' });
    }
    // The same envelope as GET /workflows/:id, so a caller reads one shape.
    res.json({ dataArray: [row] });
  });

  // ── WHAT STARTS A WORKFLOW (the engine's lib/triggers.js) ───────────────
  //
  // The kinds on offer, for a screen that builds a trigger form; the
  // workflows a given trigger starts (?kind=job&jobId=…: "what runs after this
  // job" — the jobs screen's "After this job" reads it); and what one
  // workflow's trigger last did. A trigger itself is saved as part of the
  // workflow, through /workflows/save, and checked there.
  //
  // BEFORE the generic mount, for the reason by-key is.
  router.get('/triggers', gate, function(req, res) {
    // With the words and the form's fields, so a designer offers exactly the
    // kinds this engine accepts and asks for what each one needs.
    res.json({ dataArray: triggers.catalog() });
  });

  router.get('/workflows/by-trigger', gate, async function(req, res) {
    var kind = String(req.query.kind || '').trim();
    if (!kind) return res.status(400).json({ message: 'Say which kind of trigger: ?kind=job&jobId=…', code: 'TRIGGER_INVALID', details: [] });
    var q = Workflow.query().whereRaw("\"trigger\"->>'kind' = ?", [kind]).withGraphFetched('steps').orderBy('recordCreatedDate', 'asc');
    Object.keys(req.query).forEach(function(k) {
      if (k === 'kind' || !/^[A-Za-z][A-Za-z0-9]*$/.test(k)) return;
      q = q.whereRaw("\"trigger\"->>? = ?", [k, String(req.query[k])]);
    });
    res.json({ dataArray: await q });
  });

  router.get('/workflows/:id/trigger', gate, async function(req, res) {
    var row = await Workflow.query().findById(req.params.id);
    if (!row) return res.status(404).json({ status: 'error', message: 'No workflow ' + req.params.id + '.' });
    res.json({ dataArray: [await triggers.describe(row)] });
  });

  router.post('/workflows/save', gate, refuseScreensEdit);
  router.use('/workflows', gate, genericRoute({
    key: 'workflow',
    model: Workflow,
    children: [{ key: 'steps', model: WorkflowStep, foreignKey: 'workflowId' }]
  }));

  // `details` is passed through when the engine refuses on the workflow's own
  // declared params — [{ field, message }], the same shape applySchema throws
  // everywhere else. Without it the dialog can only print one sentence; with
  // it, it can mark the field that is actually missing.
  router.post('/workflows/:id/run', gate, async function(req, res) {
    try {
      var run = await workflowRunner.startRun(req.params.id, req.body || {}, { user: req.user });
      res.json({ dataArray: [run] });
    } catch (err) {
      res.status(400).json({ message: err.message, code: err.code, details: err.details || [] });
    }
  });

  // ── flows: a screen is a step ───────────────────────────────────────────
  //
  // A small facade over the same engine for an app that designs screens: it
  // says "this screen, then that one if the answer was X", and never learns
  // what a workflow, a wait step or a resume key is. See lib/flows.js.
  //
  // Mounted HERE, inside this router, so a host that already mounts
  // registerWorkflow()'s router gets <mount>/flows with no further wiring.
  // registerWorkflow ALSO returns it on its own (`flowsRouter`) for a host
  // that would rather serve it from a path of its own — it is the same
  // builder, gating itself, so both mounts behave identically.
  router.use('/flows', buildFlowsRouter(config));

  // ── email templates ─────────────────────────────────────────────────────
  //
  // Served FROM @xeplr/email, not reimplemented here: the templates belong to
  // the email service, which is what auth and jobs also send through. This
  // mount just makes them reachable from the workflow builder, so an
  // email-send step can offer a dropdown of real template names instead of
  // asking somebody to type one exactly right.
  //
  // Conditional because templates are optional: an install that never called
  // initTemplates() serves no such routes rather than serving routes that
  // always 500.
  try {
    var emailPkg = require('@xeplr/email');
    if (emailPkg.templatesReady && emailPkg.templatesReady()) {
      router.use(emailPkg.templatesRouter({ auth: gate }));
    }
  } catch (_) {
    // @xeplr/email not installed — nothing to mount, and the email-send
    // action says so specifically if a step names a template.
  }

  // ── filling in a step's SAMPLE OUTPUT ───────────────────────────────────
  //
  // Two ways, because they trade off differently and the builder offers both.
  //
  // The SAFE one: whatever this step actually returned the last time a real
  // run reached it. No side effects at all — it is a read of history.
  router.get('/workflows/:id/steps/:stepKey/last-output', gate, async function(req, res) {
    try {
      var runs = await db.model('WorkflowRun').query().where({ workflowId: req.params.id }).select('id');
      if (!runs.length) return res.json({ dataArray: [] });
      var last = await db.model('WorkflowStepRun').query()
        .whereIn('runId', runs.map(function(r) { return r.id; }))
        .where({ stepKey: req.params.stepKey })
        // 'waiting' counts: a wait step's action has already run and produced
        // its output by then — that is exactly the shape the builder wants.
        .whereIn('status', ['success', 'waiting'])
        .orderBy('recordCreatedDate', 'desc')
        .first();
      res.json({ dataArray: last ? [{ output: last.output || {}, at: last.recordCreatedDate }] : [] });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  // The LIVE one: run the action for real, right now, with the values the
  // builder currently has on screen (which may be unsaved — hence they come in
  // the body rather than being read back off the step).
  //
  // THIS IS NOT A SIMULATION and there is nothing here that could make it one.
  // runAction is the same call the engine makes, so email-send sends,
  // email-delete expunges, db-push writes. The UI confirms before calling
  // this; that confirmation is the only thing standing between a builder
  // click and a real side effect, so it must not be removed on the grounds
  // that it is "just a preview".
  //
  // References are interpolated against the OTHER steps' recorded sample
  // outputs rather than a live context — there is no run here to have a
  // context. So a value bound to {steps.x.output.id} resolves to whatever
  // sample step x carries, which is the point: it is what makes a try-run
  // produce a realistic result instead of posting the literal string
  // "{steps.x.output.id}" to somebody's API.
  router.post('/workflows/:id/steps/try', gate, async function(req, res) {
    var body = req.body || {};
    if (!body.actionName) return res.status(400).json({ message: 'actionName is required' });
    try {
      var steps = await db.model('WorkflowStep').query()
        .where({ workflowId: req.params.id }).orderBy('position');

      // Same `env` branch the real engine builds, for the same reason the
      // sample outputs are here: a try-run that resolves a binding
      // differently from the run is worse than no try-run at all.
      var context = { params: body.params || {}, steps: {}, previous_step: {}, item: null, env: exposedEnv(), resumeKey: null };
      steps.forEach(function(s) {
        if (s.stepKey) context.steps[s.stepKey] = { output: s.sampleOutput || {} };
      });
      var selfIndex = steps.findIndex(function(s) { return s.stepKey === body.stepKey; });
      var prev = selfIndex > 0 ? steps[selfIndex - 1] : null;
      if (prev) context.previous_step = { output: prev.sampleOutput || {} };

      var input = interpolateAll(body.values || {}, context);
      var result = await runAction({ name: body.actionName, input: input });
      res.json({
        dataArray: [{
          status: result.status,
          output: result.output,
          error: result.error,
          durationMs: result.durationMs,
          // Echoed back so the builder can show what it actually sent — a
          // try-run that fails is usually a binding that resolved to
          // something unexpected, and guessing at that is the slow way.
          input: input
        }]
      });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  // Deliberately NOT gated — see workflowRunner.resumeByKey's own doc
  // comment. Whatever mounts this router (this package's own standalone app,
  // or a host's) must exempt "<mountPath>/public/*" from its OWN
  // authentication middleware too, the same way orchestration/standalone.js
  // does for itself — by the time a request reaches this router, any
  // app-level auth gate has already run and this route can no longer opt out
  // of it from in here.
  router.post('/public/resume/:key', async function(req, res) {
    try {
      var body = req.body || {};
      // `status: 'failed'` resolves the parked step as FAILED rather than
      // succeeded — see resumeByKey. Absent means success, which is what every
      // caller that predates this means: an approval click, a confirmation
      // link. @xeplr/jobs sends it when a job ended any way other than
      // completing, so a chain does not walk on past a movement that never
      // happened.
      var result = await workflowRunner.resumeByKey(req.params.key, body.output, {
        status: body.status,
        error: body.error
      });
      res.json({ dataArray: [result] });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  return router;
}

// POST /workflows/save: a 'screens' workflow is refused (see the engine's
// flows.touchesScreens), and so is a trigger that could never fire.
async function refuseScreensEdit(req, res, next) {
  try {
    if (await flows.touchesScreens(req.body)) {
      return res.status(400).json({ message: flows.SCREENS_EDIT_MESSAGE, code: 'FLOW_READ_ONLY', details: [] });
    }
    // A TRIGGER THAT COULD NEVER FIRE, refused here with its reason. The
    // model checks it too, but the generic save answers a model's refusal as
    // a bare "Validation failed", and the caller needs to know which cron or
    // which job id is wrong.
    var entries = Array.isArray(req.body) ? req.body : (req.body ? [req.body] : []);
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i] || entries[i].trigger === undefined) continue;
      try { engine.triggers.validate(entries[i].trigger); } catch (err) {
        return res.status(400).json({ message: err.message, code: err.code || 'TRIGGER_INVALID', details: [{ field: 'trigger', message: err.message }] });
      }
    }
    // The same for an arrow written as `when` (the engine compiles it into
    // its condition on save; a bad one is refused here with its reason).
    for (var e = 0; e < entries.length; e++) {
      var steps = entries[e] && Array.isArray(entries[e].steps) ? entries[e].steps : [];
      for (var k = 0; k < steps.length; k++) {
        if (!steps[k] || steps[k].deleted) continue;
        try { engine.conditions.compileTransitions(steps[k].transitions, steps[k].name || steps[k].stepKey); } catch (err) {
          return res.status(400).json({ message: err.message, code: err.code || 'CONDITION_INVALID', details: [{ field: 'transitions', message: err.message }] });
        }
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = buildWorkflowRouter;
module.exports.refuseScreensEdit = refuseScreensEdit;
