// TASKS, AS HTTP — the inbox and what people do with it.
//
// Plumbing like the flows router: each route calls one function in the
// engine's lib/tasks.js and answers. Who may act on a task is decided there,
// from req.user ({ id, roles }), which the host's auth gate put on the
// request. The same envelope and the same per-route gate as /flows, so a
// client (the web inbox, the phone app) treats them alike.
//
//   GET  /tasks/mine?limit=&offset=   my open tasks, my roles', anyone's  workflows:view
//   POST /tasks/:id/claim             take it                              workflows:run
//   POST /tasks/:id/release           put it back                          workflows:run
//   POST /tasks/:id/answer            { decision, comment } or { values, action }   workflows:run
//   POST /tasks/:id/reassign          { userId | role, reason }            workflows:admin

var express = require('express');
var tasks = require('@xeplr/workflow-engine').tasks;
var flowsRouter = require('./flowsRouter');

var API_NAMES = {
  listMine: 'List my tasks',
  claim: 'Take task',
  release: 'Put task back',
  answer: 'Answer task',
  reassign: 'Reassign task'
};

function noop(req, res, next) { next(); }

function buildTasksRouter(config) {
  config = config || {};
  var tenantGate = config.mtMembershipGate || noop;
  var allow = function(name) {
    return config.access ? [tenantGate, flowsRouter.requireApi(API_NAMES[name])] : [tenantGate];
  };
  var handle = flowsRouter.handle;
  var router = express.Router();

  router.get('/mine', allow('listMine'), handle(function(req) {
    return tasks.listMine(req.user, { limit: req.query.limit, offset: req.query.offset });
  }));
  router.post('/:id/claim', allow('claim'), handle(function(req) {
    return tasks.claim(req.params.id, req.user);
  }));
  router.post('/:id/release', allow('release'), handle(function(req) {
    return tasks.release(req.params.id, req.user);
  }));
  router.post('/:id/answer', allow('answer'), handle(function(req) {
    return tasks.answer(req.params.id, req.body || {}, req.user);
  }));
  router.post('/:id/reassign', allow('reassign'), handle(function(req) {
    var body = req.body || {};
    return tasks.reassign(req.params.id, { userId: body.userId, role: body.role },
      { reason: body.reason, actor: req.user && req.user.id });
  }));

  return router;
}

module.exports = buildTasksRouter;
module.exports.API_NAMES = API_NAMES;
