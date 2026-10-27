-- 0009_screens_waiting_access.sql
-- SCREENS INSIDE WORKFLOWS (lib/flowsRouter.js):
--
--   GET /flows/waiting   screens waiting for one of the caller's roles   workflows:view
--
-- And who may submit one: a screen is assigned to a role on its step
-- (screen-show's assignTo), and the engine refuses anyone without it
-- (NOT_YOURS). That is the real gate, so 'Submit flow screen' (workflows:run)
-- goes to Viewer too: a reviewer in Accounts may well be a Viewer.
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('List screens waiting', 'workflows:view')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator', 'Viewer')
  AND ((a."apiGroup" = 'workflows:view' AND a.name = 'List screens waiting')
    OR (a."apiGroup" = 'workflows:run' AND a.name = 'Submit flow screen'))
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
