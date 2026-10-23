-- 0004_flows_access.sql
-- The `apis` rows for the FLOWS FACADE — the routes an app that designs
-- screens talks to (lib/flowsRouter.js, mounted at <mount>/flows).
--
-- A SEPARATE MIGRATION rather than an edit to 0001, for the reason 0003 gives:
-- the migrator records what it has applied by filename and will not re-run a
-- file whose contents changed, so an edit to 0001 would seed nothing at all.
--
-- ── which groups these land in, and why ─────────────────────────────────
--
-- The same three the workflow routes already use, because a flow is a
-- workflow and the questions are the same ones:
--
--   workflows:view    listing flows, reading one, reading a run
--   workflows:create  creating, replacing the steps of a draft, publishing
--   workflows:run     starting a run, and submitting a screen
--
-- SUBMITTING IS A RUN RIGHT, NOT A VIEW RIGHT, and that is the only
-- non-obvious one. It reads like filling in a form, but it moves a run to its
-- next step and every side effect the rest of the flow has follows from it.
-- 0001 put running under workflows:run precisely because a run has side
-- effects, and a Viewer who can submit a screen can cause all of them.
--
-- NO MENU ROWS. There is no page in this product for any of this — the
-- screens live in another app entirely, and this product's own builder shows a
-- flow read-only through the workflow pages it already has menus for. A menu
-- row for a page that does not exist puts a dead item in everyone's rail.
--
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('List flows', 'workflows:view'),
  ('Get flow', 'workflows:view'),
  ('Get flow run', 'workflows:view'),
  ('List flow runs', 'workflows:view'),
  ('Create flow', 'workflows:create'),
  ('Replace flow steps', 'workflows:create'),
  ('Publish flow', 'workflows:create'),
  ('Start flow run', 'workflows:run'),
  ('Submit flow screen', 'workflows:run')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Super Admin → everything, including whatever was just added.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- The same matrix 0001 established, re-run so it covers the new rows: its own
-- inserts only ever saw the apis that existed when it ran.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'CompanyAdmin'
  AND (a."apiGroup" LIKE 'workflows:%' OR a."apiGroup" LIKE 'configuration:%')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Creator'
  AND a."apiGroup" IN ('workflows:view', 'workflows:create', 'workflows:run')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Viewer: workflows:view only. Sees the flows and their runs; starts nothing
-- and submits nothing.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Viewer'
  AND a."apiGroup" = 'workflows:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
