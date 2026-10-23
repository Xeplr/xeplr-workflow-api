/**
 * Mandatory env vars for the xeplr-workflow API process running STANDALONE.
 * Checked by orchestration/standalone.js at startup and at build (`npm run
 * check-env`). The auth service (xeplr-auth-server) reads its own env directly.
 *
 * NOT the list for an EMBEDDED mount — see `embedRequiredEnv` in index.js. A
 * host app passes workflow's connection and database name as arguments to
 * registerWorkflow({ db }), so none of the connection vars below apply to it,
 * and registerWorkflow never runs this check.
 *
 * Framework var NAMES are owned by the libraries — spread their `requiredEnv`
 * so you never re-list them, and a new lib requirement lands in every app for
 * free. Only APP-SPECIFIC vars are listed literally.
 *
 * Same shape as xeplr-bi's, deliberately: two apps that boot differently are
 * two apps to learn.
 */
module.exports = [
  ...require('@xeplr/base-apis').gateRequiredEnv,  // AUTH_URL — standalone uses createApp's own gate
  ...require('@xeplr/auth').requiredEnv,           // ENCRYPTION_KEY, JWT_SECRET, ACTIVATION_BASE_URL
  ...require('@xeplr/email').requiredEnv,          // EMAIL_PROVIDER, BREVO_* (app sends invite mail)
  // This app also OWNS A TEMPLATE STORE (orchestration/standalone.js calls
  // initTemplates). Templates are app-specific — a registration mail is
  // written for one product — so the store is this app's own, not a shared
  // xeplr_email that another product could overwrite by template name.
  ...require('@xeplr/email').templatesRequiredEnv, // EMAIL_DB_NAME
  ...require('@xeplr/actions').configRequiredEnv,  // XCFG_DB_NAME, XCFG_DB_CONNECTION_INFO_ENCRYPTED

  // App-specific — names this app chose (checked by the API process):
  //
  // WORKFLOW_CONNECTION is NOT here, deliberately: it is an OVERRIDE. The
  // server login normally comes from the shared XEPLR_DB_CONNECTION that every
  // xeplr service reads, so demanding the workflow-specific name would fail a
  // correctly configured install. It still wins when set. Missing-ness is
  // caught at the point of use by resolveDbConnection (see standalone.js),
  // which names both variables. Same call auth and actions already made —
  // xeplr-auth/index.js and @xeplr/actions' attach.js.
  'DB_API',                              // api database name
  'WORKFLOW_PORT',                       // api port — NOT hardcoded anywhere
  'AUTH_SUPER_ADMIN_PASSWORD'            // consumed by migrations-auth/0002_super_admin.sql
];
