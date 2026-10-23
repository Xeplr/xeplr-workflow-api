-- 0005_workflow_license_module.sql
-- Xeplr Workflow is a licensed Xeplr Suite product, so its routes belong to
-- the 'workflow' licence module (@xeplr/auth 0007's licenseModule column).
--
-- By group, not by name: every workflow route is in a workflows:* group, and
-- a route added later in one is covered by re-running this. Menus are left to
-- the host, which names its own rail item (Xeplr BI: 'Workflows', in its
-- migrations-auth/0035) — this package's 0001/0003 also seed generic menus
-- (Home, Dashboards, Jobs) for the standalone app that are not workflow's.
--
-- Nothing filters on the column yet. It is set now so that switching licence
-- enforcement on later needs no archaeology.

UPDATE "apis" SET "licenseModule" = 'workflow'
WHERE "apiGroup" LIKE 'workflows:%' AND "licenseModule" <> 'workflow';
