-- 0006_workflow_job_chains_access.sql
-- The `apis` rows for JOB CHAINS — a job's "After this job" rules
-- (lib/jobChainsRouter.js, mounted at <mount>/job-chains).
--
--   workflows:view    reading a job's rules
--   workflows:create  saving them (which writes the workflow they become)
--
-- No menu rows: the rules are edited on the jobs screen, which has its own.
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('Get job chain', 'workflows:view'),
  ('Save job chain', 'workflows:create')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Licensed with the rest of Xeplr Workflow, as 0005 tags every workflows:* row.
UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';

-- Super Admin → everything.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- CompanyAdmin → every workflows group (its rows stay within its own company).
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'CompanyAdmin'
  AND (a."apiGroup" LIKE 'workflows:%' OR a."apiGroup" LIKE 'configuration:%')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Creator: view, create and run — the same people who create and run jobs.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Creator'
  AND a."apiGroup" IN ('workflows:view', 'workflows:create', 'workflows:run')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Viewer: reads a job's rules, changes nothing.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Viewer'
  AND a."apiGroup" = 'workflows:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
