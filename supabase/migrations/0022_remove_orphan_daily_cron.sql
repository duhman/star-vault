-- Migration: Remove the orphan 'star-vault-daily-sync' pg_cron job.
--
-- Background: a previous version of this project used a single monolithic
-- Edge Function `star-vault-sync` triggered once a day at 07:00 UTC. That
-- function was replaced (0018) by four focused Edge Functions running
-- hourly. The daily cron job was left behind, calling a 404 endpoint.
-- Idempotent: unschedule is a no-op if the job doesn't exist.
do $$
begin
  perform cron.unschedule('star-vault-daily-sync')
    where exists (select 1 from cron.job where jobname = 'star-vault-daily-sync');
exception when undefined_function then
  null;
end $$;
