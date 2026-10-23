var createApp = require('@xeplr/base-apis/express');
var engine = require('@xeplr/workflow-engine');
var buildWorkflowRouter = require('./lib/router');
var buildFlowsRouter = require('./lib/flowsRouter');

/**
 * Register workflow into a host app, or stand up its own.
 *
 *   // Embedded — mounted into a caller's existing Express app:
 *   await registerWorkflow({
 *     app: myExpressApp,
 *     mountPath: '/workflow',
 *     db: { name: 'xeplr_bi_workflow', connection: myDbConnectionString },
 *     mtMembershipGate: myAlreadyBuiltGate    // omit → every route ungated
 *   });
 *
 *   // Standalone — this package creates and starts its own app via
 *   // @xeplr/base-apis' createApp (the only thing that ever builds an app
 *   // here, embedded or standalone). See orchestration/standalone.js, which
 *   // is exactly this call with its config sourced from development.env.
 *   await registerWorkflow({ db: {...}, port: 19122, middleware: [...] });
 *
 * @param {object} config
 * @param {import('express').Express} [config.app] - an existing Express app
 *   to mount onto. Omit WITH config.port to have this package create and
 *   start its own; omit BOTH to get the router back and mount it yourself.
 *
 *   That third mode is not a convenience — for some hosts it is the only
 *   thing that works. @xeplr/base-apis' createApp registers a catch-all 404
 *   AFTER the routes it was given, so anything app.use()'d afterwards sits
 *   behind it and is never reached: the mount succeeds, and every path under
 *   it answers 404. A host built that way has to hand the router in with its
 *   own route map rather than bolt it on after.
 * @param {object} config.db - { name, connection, mts?, connectionName?, migrationsTable? } —
 *   see lib/db.js. migrationsTable: workflow's own migration ledger, for a
 *   database it SHARES with its host (default: @xeplr/db's xeplr_migrations).
 * @param {boolean} [config.tenantTables=true] - false: do not create
 *   standalone workflow's own companies / workspaces tables — a host with its
 *   own tenants (or none) passes this.
 * @param {boolean} [config.access=false] - true: every flows route answers only
 *   a caller whose permissions (req.access.apis) name it — "List flows",
 *   "Start flow run"… from migrations-auth/0004_flows_access.sql. Fails
 *   closed when no auth gate put req.access on the request.
 *   Always required: workflow's own domain data is always its own
 *   responsibility, however it's mounted.
 * @param {string} [config.applicationId] - the PRODUCT mounting this
 *   ('xeplr-bi', 'xeplr-erp'; 'xeplr-workflow' standalone). OPTIONAL: a host
 *   normally calls registerApplication() once at its own startup and every
 *   sub-product it mounts inherits that, so passing this again is only for a
 *   host that prefers to be explicit.
 *
 *   It does NOT separate workflow's own data — config.db does that. Each host
 *   gives workflow its own database (xeplr_bi_workflow, xeplr_erp_workflow),
 *   which is the whole boundary, and is why none of these tables carries an
 *   applicationId column.
 *
 *   What it IS for: xeplr_configs, the one store that cannot be split per
 *   consumer because every app opens it. This mount writes movement metadata
 *   there, and those rows are attributed by applicationId. So an identity has
 *   to be registered by the time this is called — hence the throw below when
 *   neither this nor a prior registerApplication() supplied one.
 * @param {string} [config.mountPath='/workflow'] - only meaningful when this
 *   package creates its own app; a host app's own app.use() call decides its
 *   own mount path when embedding.
 * @param {number} [config.port] - only used when creating a standalone app.
 * @param {string} [config.appName='xeplr_workflow_api']
 * @param {Function} [config.mtMembershipGate] - see lib/router.js
 * @param {Function} [config.authMiddleware] - see lib/router.js
 * @param {Function[]} [config.middleware] - only used when creating a
 *   standalone app — passed straight to createApp.
 * @param {object|false} [config.log] - only used when creating a standalone app.
 * @returns {Promise<{ router: import('express').Router, flowsRouter: import('express').Router, app: import('express').Express, server?: import('http').Server }>}
 *   `router` carries every route including the flows facade at
 *   `<mount>/flows`. `flowsRouter` is that facade on its own, for a host that
 *   would rather mount it somewhere else as well — see the note where it is
 *   built.
 */
async function registerWorkflow(config) {
  config = config || {};
  if (!config.db) {
    throw new Error('registerWorkflow: config.db is required — workflow owns its own domain data regardless of how it is mounted');
  }
  // The database, its tables, the action catalog: all the engine's. See
  // @xeplr/workflow-engine's startEngine for why each is done there.
  await engine.startEngine(config);

  var router = buildWorkflowRouter(config);

  // THE FLOWS FACADE, ALSO ON ITS OWN. It is already inside `router` at
  // <mount>/flows, which is all most hosts need. This second, independent
  // instance is for a host that wants to serve it from a path of its own —
  // routes['/flows'] = flowsRouter, beside routes['/workflow'] = router —
  // because the app designing the screens is not the app that mounted the
  // workflow builder and should not have to reach through its URL space.
  //
  // Same builder, same config, and it gates itself, so the two mounts are
  // interchangeable rather than merely similar. Mounting both is fine; they
  // share nothing but the database.
  var flowsRouter = buildFlowsRouter(config);

  if (config.app) {
    config.app.use(config.mountPath || '/workflow', router);
    return { router: router, flowsRouter: flowsRouter, app: config.app };
  }

  // No app to mount onto and no port to listen on: the caller wants the
  // router itself. See the note on config.app.
  if (!config.port) return { router: router, flowsRouter: flowsRouter };

  var mountPath = config.mountPath || '/workflow';
  var routes = {};
  routes[mountPath] = router;

  var built = createApp(config.port, config.appName || 'xeplr_workflow_api', {
    // Passed through, NOT defaulted here: undefined means createApp's own
    // default, which is gated. Only reached in STANDALONE mode — an embedded
    // mount returns above, and its host's own app already carries a gate.
    auth: config.auth,
    log: config.log,
    middleware: config.middleware || [],
    routes: routes
  });

  return { router: router, flowsRouter: flowsRouter, app: built.app, server: built.server };
}

// The engine's own exports, passed through so a host that mounts the API
// needs one require: resumeByKey, and the env lists to spread into its
// env.required.js (DB_WORKFLOW; WORKFLOW_PUBLIC_URL for job-run steps).
module.exports = {
  registerWorkflow: registerWorkflow,
  resumeByKey: engine.resumeByKey,
  embedRequiredEnv: engine.embedRequiredEnv,
  callbackRequiredEnv: engine.callbackRequiredEnv
};
