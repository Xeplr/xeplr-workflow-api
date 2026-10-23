// The ONLY file in this package that reads development.env or process.env
// directly. Everything downstream of here (lib/, models/, index.js) takes
// config as arguments — this file's entire job is turning env vars into that
// config, then calling the exact same registerWorkflow() a host app would
// call itself. Running workflow standalone (`npm run start-api`) is this
// package consuming its own public API, not a separate code path.

require('dotenv').config({ path: require('path').join(__dirname, '..', (process.env.NODE_ENV || 'development') + '.env') });

require('@xeplr/base-apis').checkEnv(require('../env.required.js'), { appName: 'api' });

var { resolveConfig, mtMiddleware, resolveDbConnection, registerApplication } = require('@xeplr/db');

// WORKFLOW_CONNECTION is an OVERRIDE now — the connection normally comes from
// the shared XEPLR_DB_CONNECTION that every xeplr service reads, so rotating
// the database password is one edit rather than one per service. DB_API (which
// database) is untouched and stays workflow's own.
function workflowConnection() { return resolveDbConnection('WORKFLOW_CONNECTION'); }
var { up } = require('@xeplr/db').sqlMigrator;
var { authMiddleware, mtMembershipMiddleware } = require('@xeplr/auth');
var engine = require('@xeplr/workflow-engine');
var xcfgSetup = engine.xcfgSetup;
var actionCatalog = engine.actionCatalog;
var { registerWorkflow } = require('../index');


async function start() {
  // This process runs workflow as its own product, so the package name is the
  // application name — the one case where they coincide (an embedded mount
  // inherits its host's id instead; see registerWorkflow).
  //
  // Declared BEFORE xcfgSetup.ready() below, which resolves its applicationId
  // from this registry: the rows this process writes into the SHARED
  // xeplr_configs have to be attributed to workflow rather than falling back
  // to a default that happens to be right here and would hide the mistake
  // from anyone copying this file. Workflow's OWN tables need none of this —
  // they live in this deployment's own database.
  var APPLICATION_ID = process.env.WORKFLOW_APPLICATION_ID || 'xeplr-workflow';
  registerApplication(APPLICATION_ID);
  console.log('[api] application: ' + APPLICATION_ID);

  await resolveConfig('api', workflowConnection());

  var result = await up({
    db: process.env.DB_API,
    dir: engine.MIGRATIONS_DIR,
    connectionName: 'api'
  });
  console.log(result.migrations.length
    ? '[api] ran ' + result.migrations.length + ' migrations'
    : '[api] migrations up to date');

  // xeplr_configs — shared control-plane DB. Required, fail-fast: several
  // built-in actions write movement metadata through it, and starting
  // without it would run workflows that silently record nothing.
  await xcfgSetup.ready();
  console.log('[api] xeplr_configs ready');

  var registered = actionCatalog.registerAll();
  console.log('[api] registered ' + registered.length + ' actions: ' + registered.join(', '));

  // This process's own auth — connects to whatever AUTH_DB_NAME /
  // AUTH_DB_CONNECTION_INFO_ENCRYPTED point at. A HOST app embedding
  // workflow via registerWorkflow({ app, ... }) supplies its own
  // already-built mtMembershipGate/authMiddleware instead of any of this —
  // this file exists only for running workflow entirely on its own.
  var auth = engine.auth;   // the one the Company / Workspace hooks also use
  require('@xeplr/email').configureFromEnv();

  // The TEMPLATE STORE — its own database (xeplr_email), created on first
  // boot. Best-effort: an install with no XEPLR_DB_CONNECTION reachable still
  // runs, it just cannot use templated email. Failing the whole API over a
  // feature a workflow may never touch would be the wrong trade.
  try {
    await require('@xeplr/email').initTemplates();
    console.log('[api] email templates ready');
  } catch (err) {
    console.warn('[api] email templates unavailable (' + err.message + ') — steps using templateName will fail until this is fixed');
  }
  await auth.ready();
  var mtMembershipGate = mtMembershipMiddleware({ userTenantsMapping: auth.model('UserTenantsMapping') });

  await registerWorkflow({
    // Already registered at the top of start(); passed again only to keep
    // this call self-describing. Idempotent under the same value.
    applicationId: APPLICATION_ID,
    db: {
      name: process.env.DB_API,
      connection: workflowConnection(),
      // Two tenancy levels, l1 = companyId / l2 = workspaceId — mirrored in
      // @xeplr-workflow/ui's src/main.jsx's own registerMTs() call for the standalone UI.
      mts: {
        l1: { name: 'companyId', header: 'x-company-id' },
        l2: { name: 'workspaceId', header: 'x-workspace-id' }
      }
    },
    port: process.env.WORKFLOW_PORT,
    mountPath: '/', // preserves today's URLs — no /workflow prefix standalone
    appName: 'xeplr_workflow_api',
    log: { logDir: process.env.LOG_DIR || './logs' },
    // THE GATE, in the slot createApp reserves for it — and createApp's OWN
    // gate, not a JWT check private to this process. One implementation of
    // "is this caller authenticated" across every service, so a change to how
    // a token is validated lands in one place instead of in each app's copy.
    //
    // publicPaths replaces what gatedAuth did by hand: /public/* is open by
    // design (see lib/router.js on POST /public/resume/:key — a resume link is
    // followed from an email client, with no token to send), and /events would
    // be too if this process ever mounts an SSE stream, since EventSource
    // cannot set an Authorization header.
    auth: { publicPaths: ['/public/', '/events'] },
    middleware: [mtMiddleware()],
    mtMembershipGate: mtMembershipGate,
    authMiddleware: authMiddleware
  });
}

start().catch(function(err) {
  console.error('[api] startup failed:', err.stack || err.message);
  process.exit(1);
});

module.exports = start;
