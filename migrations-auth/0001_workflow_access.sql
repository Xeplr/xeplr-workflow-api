-- 0001_workflow_access.sql
-- xeplr-workflow's AUTH-DB extension data — layered on top of auth's base
-- migrations (runs after them: AUTH_EXT_MIGRATIONS_DIR). Adds this product's
-- roles + menus, maps Super Admin to everything, and applies the default
-- role→access matrix. All inserts are insert-if-absent (WHERE NOT EXISTS),
-- safe to re-run against an already-seeded DB.
--
-- Its OWN auth database (AUTH_DB_NAME=xeplr_workflow_auth), not xeplr-bi's.
-- Sharing one would mean a role granted in BI silently granting workflow
-- pages, which is not a thing anybody would have decided on purpose.

INSERT INTO "roles" (id, name, "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, true, '*', now(), now()
FROM (VALUES ('Super Admin'), ('CompanyAdmin'), ('Creator'), ('Viewer')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r.name = v.name);

-- The drawer reads these: a menu row named here shows up in the nav for any
-- role mapped to it, and does not exist for a role that isn't.
-- The drawer reads these: a menu row named here shows up in the nav for any
-- role mapped to it, and does not exist for a role that isn't. Add the
-- workflow pages' rows in a LATER migration alongside the pages themselves —
-- seeding a menu for a page that does not exist yet puts a dead item in the
-- rail for everyone.
INSERT INTO "menus" (id, name, "menuGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('Home', 'workflows:view'),
  ('Actions', 'workflows:view'),
  ('Configuration', 'configuration:view'),
  ('Access Control', 'configuration:access:view')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "menus" m WHERE m.name = v.name);

-- This product's own APIs. Every route in routes/index.js that should be
-- gate-able gets a row here, grouped to match the menuGroup/apiGroup values
-- the role matrix below already reads. `/public/resume/:key` is isPublic —
-- it's never gated by role at all (a resume click isn't made by a signed-in
-- user), so it's grouped for bookkeeping only, not for the matrix below to
-- match against.
INSERT INTO "apis" (id, name, "apiGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", "public", true, '*', now(), now()
FROM (VALUES
  ('List workflows', 'workflows:view', false),
  ('Get workflow', 'workflows:view', false),
  ('List actions', 'workflows:view', false),
  ('Save workflow', 'workflows:create', false),
  ('Delete workflow', 'workflows:create', false),
  ('Run workflow', 'workflows:run', false),
  ('Resume workflow step', 'workflows:public', true)
) AS v(name, "group", "public")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Super Admin → everything that now exists (base apis/pages/elements/menus +
-- this product's menus).
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

INSERT INTO "uiPagesRolesMapping" (id, "roleId", "uiPageId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, p.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "uiPages" p
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "uiPagesRolesMapping" m WHERE m."roleId" = r.id AND m."uiPageId" = p.id);

INSERT INTO "uiElementsRolesMapping" (id, "roleId", "uiElementId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, e.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "uiElements" e
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "uiElementsRolesMapping" m WHERE m."roleId" = r.id AND m."uiElementId" = e.id);

INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

-- Scoped-role default access matrix (global WHAT; per-company/workspace scope
-- comes from userTenantsMapping, not from this).

-- CompanyAdmin: workflows:* and configuration:* (prefix).
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'CompanyAdmin'
  AND (m."menuGroup" LIKE 'workflows:%' OR m."menuGroup" LIKE 'configuration:%')
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'CompanyAdmin'
  AND (a."apiGroup" LIKE 'workflows:%' OR a."apiGroup" LIKE 'configuration:%')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Creator: can see, build and run. Note that RUNNING is deliberately a
-- creator's right and not a viewer's — a run has side effects (it sends mail,
-- moves files, writes to databases), so "can look at it" must not imply "can
-- fire it".
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Creator'
  AND m."menuGroup" IN ('workflows:view', 'workflows:create', 'workflows:run')
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Creator'
  AND a."apiGroup" IN ('workflows:view', 'workflows:create', 'workflows:run')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Viewer: workflows:view (exact). Sees the workflows and their history; fires
-- nothing.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Viewer'
  AND m."menuGroup" = 'workflows:view'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Viewer'
  AND a."apiGroup" = 'workflows:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
