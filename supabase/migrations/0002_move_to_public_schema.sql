-- OBSOLETE MIGRATION (intentionally no-op)
-- -----------------------------------------------------------------------------
-- Historical note:
-- This migration previously attempted to move Star Vault objects from
-- `star_vault.*` to `public.sv_*`. The active runtime is now canonicalized on
-- `star_vault.repos`, `star_vault.sync_state`, and `star_vault.search_repos`.
--
-- Do NOT add destructive schema moves in this file.
-- Reconciliation is handled by:
--   003_reconcile_star_vault_canonical.sql
-- -----------------------------------------------------------------------------

select 1;
