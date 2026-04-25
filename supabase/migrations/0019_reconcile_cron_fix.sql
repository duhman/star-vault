-- Migration: Point the weekly reconcile cron job at the new sync-reconcile
-- Edge Function.
--
-- Why: 0018 originally scheduled the weekly reconcile to call sync-stars
-- with body {"reconcile": true}, but sync-stars doesn't read that body and
-- doesn't do the DELETE step. sync-reconcile is the canonical reconcile path:
-- authoritative walk + safety gate + DELETE.
do $$
begin
  perform cron.unschedule('star-vault-reconcile-weekly')
    where exists (select 1 from cron.job where jobname = 'star-vault-reconcile-weekly');
exception when undefined_function then
  null;
end $$;

select
  cron.schedule (
    'star-vault-reconcile-weekly',
    '33 4 * * 0', -- Sundays at 04:33 UTC
    $$ select star_vault.invoke_edge_function('sync-reconcile'); $$
  );
