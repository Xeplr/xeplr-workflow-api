-- 0011_step_preview_access.sql
-- The `apis` row for the STEP PREVIEW (lib/router.js):
--
--   POST /workflows/:id/steps/preview   what a step would hand on, read      workflows:create
--
-- Asked while a workflow is being designed, so the group designing is: Super
-- Admin, CompanyAdmin (its own company's rows) and Creator — as 'Save
-- workflow'. It only reads, a few rows, never writes or sends.
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('Preview workflow step', 'workflows:create')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Licensed with the rest of Xeplr Workflow, as 0005 tags every workflows:* row.
UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator')
  AND a."apiGroup" = 'workflows:create'
  AND a.name = 'Preview workflow step'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
