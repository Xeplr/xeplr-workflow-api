// THE FLOWS FACADE, as HTTP.
//
// Nothing but plumbing: each route reads its parameters, calls one function in
// lib/flows.js, and answers. Everything that could be wrong — a comparison the
// engine does not have, a transition pointing at nothing, a run belonging to
// another company — is decided there, where it can be tested without a socket.
//
// ── what this answers with, and why it is not `dataArray` ───────────────
//
// Every other route in this package answers `{ dataArray: [...] }`, because
// every other route is talked to by this product's own builder through
// @xeplr/base-apis' generic controller. This one is a FACADE for a different
// app: it hands back the object the caller asked about, and an error as the
// same `{ message, code, details }` body the rest of the package already uses.
// A client of this router should not have to learn one product's response
// envelope to ask what screen a run is on.
//
// ── the gate ────────────────────────────────────────────────────────────
//
// Applied per route here rather than at the mount, so this router carries its
// own authorization wherever it is mounted — inside the workflow router at
// <mount>/flows, or by a host at a path of its own. See buildWorkflowRouter's
// note on the same `config.mtMembershipGate`.

var express = require('express');
var flows = require('@xeplr/workflow-engine').flows;

function noop(req, res, next) { next(); }

// One shape for every refusal: the status the service decided, and the body
// the rest of this package already answers errors with. `code` is what a
// client branches on — FLOW_NOT_FOUND, FLOW_PUBLISHED, RUN_NOT_WAITING — and
// `message` is the sentence somebody reads.
function sendError(res, err) {
  res.status(err.status || 400).json({
    message: err.message,
    code: err.code || null,
    details: err.details || []
  });
}

function handle(fn) {
  return async function(req, res) {
    try {
      var result = await fn(req);
      if (result && result.created) return res.status(201).json(result.body);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * @param {object} [config]
 * @param {Function} [config.mtMembershipGate] - the same gate the rest of this
 *   package's authenticated routes use. Omit to leave every route ungated,
 *   which is only ever right for local dev.
 * @returns {import('express').Router}
 */
// The permission each route needs, named as migrations-auth/0004_flows_access
// .sql grants them. Checked only with config.access — see requireApi.
var API_NAMES = {
  getRun: 'Get flow run',
  submit: 'Submit flow screen',
  list: 'List flows',
  create: 'Create flow',
  get: 'Get flow',
  replace: 'Replace flow steps',
  publish: 'Publish flow',
  startRun: 'Start flow run',
  listRuns: 'List flow runs'
};

/**
 * The caller may use this route only if its access list names it — the same
 * check @xeplr/factory makes. FAILS CLOSED: no req.access at all means the
 * router is mounted where no auth gate ran, and that must not read as allowed.
 */
function requireApi(name) {
  return function(req, res, next) {
    var apis = req.access && req.access.apis;
    if (!Array.isArray(apis)) {
      return res.status(403).json({ message: 'No access information on the request — mount the flows router behind the auth gate', code: 'NO_ACCESS_INFO', details: [] });
    }
    if (apis.indexOf(name) === -1) {
      return res.status(403).json({ message: 'Access denied: ' + name, code: 'ACCESS_DENIED', details: [] });
    }
    next();
  };
}

function buildFlowsRouter(config) {
  config = config || {};
  var tenantGate = config.mtMembershipGate || noop;
  // One middleware per route: the tenancy gate, then — with config.access —
  // the route's own permission.
  var allow = function(name) {
    return config.access ? [tenantGate, requireApi(API_NAMES[name])] : [tenantGate];
  };
  var router = express.Router();

  // BEFORE /:key. A flow keyed "runs" would otherwise shadow these two, which
  // is why normaliseKey reserves the word rather than leaving it to routing
  // order to decide.
  router.get('/runs/:runId', allow('getRun'), handle(function(req) {
    return flows.getRun(req.params.runId);
  }));

  // The browser never handles a resume key — see flows.submitRun. This is an
  // ordinary gated route that looks the key up from the run it was given.
  router.post('/runs/:runId/submit', allow('submit'), handle(function(req) {
    return flows.submitRun(req.params.runId, req.body || {});
  }));

  router.get('/', allow('list'), handle(function() {
    return flows.listFlows();
  }));

  router.post('/', allow('create'), handle(async function(req) {
    return { created: true, body: await flows.createFlow(req.body || {}) };
  }));

  router.get('/:key', allow('get'), handle(function(req) {
    return flows.getFlow(req.params.key);
  }));

  router.put('/:key', allow('replace'), handle(function(req) {
    return flows.putFlow(req.params.key, req.body || {});
  }));

  router.post('/:key/publish', allow('publish'), handle(function(req) {
    return flows.publishFlow(req.params.key);
  }));

  router.post('/:key/runs', allow('startRun'), handle(async function(req) {
    return { created: true, body: await flows.startFlowRun(req.params.key, req.body || {}, req.user) };
  }));

  // ?mine=1 — started by whoever is asking. Anything else is every run of this
  // flow that is still going, within the caller's own tenant.
  router.get('/:key/runs', allow('listRuns'), handle(function(req) {
    var mine = req.query && (req.query.mine === '1' || req.query.mine === 'true');
    return flows.listRuns(req.params.key, { mine: mine, userId: req.user && req.user.id });
  }));

  return router;
}

module.exports = buildFlowsRouter;
module.exports.API_NAMES = API_NAMES;
// Shared, so any other facade answers and gates alike.
module.exports.requireApi = requireApi;
module.exports.handle = handle;
