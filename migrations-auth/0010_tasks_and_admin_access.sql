-- 0010_tasks_and_admin_access.sql
-- THE INBOX AND THE ADMIN ACTIONS (lib/tasksRouter.js, lib/router.js):
--
--   GET  /tasks/mine            List my tasks       workflows:view
--   POST /tasks/:id/claim       Take task           workflows:run
--   POST /tasks/:id/release     Put task back       workflows:run
--   POST /tasks/:id/answer      Answer task         workflows:run
--   POST /tasks/:id/reassign    Reassign task       workflows:admin
--   POST /runs/:runId/cancel    Cancel run          workflows:admin
--   POST /runs/:runId/retry     Retry run           workflows:admin
--
-- The inbox and answering go to every role, Viewer too: the real gate is the
-- task itself — it is for a user or a role, and the engine refuses anyone
-- else (NOT_YOURS). An approver in Accounts may well be a Viewer.
--
-- workflows:admin is a NEW group and goes to Super Admin and the company admin
-- only: moving someone's work to another person, stopping a case and running
-- an interrupted step again are decisions about other people's work.
--
-- No menu rows: the inbox page lives in the apps that mount this (and the
-- phone app), each with its own drawer entry.
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('List my tasks', 'workflows:view'),
  ('Take task', 'workflows:run'),
  ('Put task back', 'workflows:run'),
  ('Answer task', 'workflows:run'),
  ('Reassign task', 'workflows:admin'),
  ('Cancel run', 'workflows:admin'),
  ('Retry run', 'workflows:admin')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE (
    (r.name IN ('Super Admin', 'CompanyAdmin', 'Creator', 'Viewer')
      AND ((a."apiGroup" = 'workflows:view' AND a.name = 'List my tasks')
        OR (a."apiGroup" = 'workflows:run' AND a.name IN ('Take task', 'Put task back', 'Answer task'))))
    OR (r.name IN ('Super Admin', 'CompanyAdmin')
      AND a."apiGroup" = 'workflows:admin' AND a.name IN ('Reassign task', 'Cancel run', 'Retry run'))
  )
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
