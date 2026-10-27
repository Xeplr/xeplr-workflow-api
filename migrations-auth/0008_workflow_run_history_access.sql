-- 0008_workflow_run_history_access.sql
-- The `apis` rows for RUN HISTORY (lib/router.js):
--
--   GET /workflows/:id/runs    a workflow's runs, newest first      workflows:view
--   GET /runs/:runId           one run, with every step it took     workflows:view
--
-- Read-only, so the view group: Super Admin, CompanyAdmin (its own company's
-- rows), Creator and Viewer, as the other workflows:view rows.
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('List workflow runs', 'workflows:view'),
  ('Get workflow run', 'workflows:view')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Licensed with the rest of Xeplr Workflow, as 0005 tags every workflows:* row.
UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator', 'Viewer')
  AND a."apiGroup" = 'workflows:view'
  AND a.name IN ('List workflow runs', 'Get workflow run')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
