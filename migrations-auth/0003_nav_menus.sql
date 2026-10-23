-- 0003_nav_menus.sql
-- The rail's new items: Dashboards, Jobs, and the two scope pickers.
--
-- A SEPARATE MIGRATION rather than an edit to 0001, because 0001 has already
-- run — the migrator records what it has applied and will not re-run a file
-- whose contents changed. Editing it would seed nothing and leave the new items
-- role-filtered out of everyone's drawer, which looks exactly like a
-- permissions bug.
--
-- Seeded alongside the pages themselves, which is the rule 0001's comment
-- states: a menu row for a page that does not exist puts a dead item in the
-- rail for everyone. Dashboards and Jobs are placeholders today, but they are
-- real routes that render a real page saying so — which is a different thing
-- from a link that goes nowhere.
--
-- Every insert is insert-if-absent, safe to re-run.

INSERT INTO "menus" (id, name, "menuGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('Dashboards', 'workflows:view'),
  ('Jobs', 'workflows:view'),
  -- The scope pickers are workflows:view rather than configuration:*. Choosing
  -- which workspace you are looking at is not administering anything, and a
  -- Viewer who cannot switch workspace is a Viewer locked into whichever one
  -- they happened to land in.
  ('Select Workspace', 'workflows:view'),
  ('Select Company', 'workflows:view')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "menus" m WHERE m.name = v.name);

-- Super Admin → everything, including whatever was just added.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

-- And the scoped roles, on the same matrix 0001 established: CompanyAdmin gets
-- the workflows:* prefix, Creator and Viewer get exact groups. Re-run here so
-- the new rows are covered — 0001's inserts only saw the menus that existed
-- when it ran.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'CompanyAdmin'
  AND (m."menuGroup" LIKE 'workflows:%' OR m."menuGroup" LIKE 'configuration:%')
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Creator'
  AND m."menuGroup" IN ('workflows:view', 'workflows:create', 'workflows:run')
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Viewer'
  AND m."menuGroup" = 'workflows:view'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);
