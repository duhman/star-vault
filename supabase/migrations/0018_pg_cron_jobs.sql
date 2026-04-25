-- Migration: Schedule sync Edge Functions via pg_cron + pg_net.
--
-- pg_cron fires at local time by default. Supabase sets the DB timezone to
-- UTC; all cron expressions here are UTC.
--
-- Idempotent: cron.unschedule on re-apply is a no-op if the job doesn't exist.
--
-- Required GUCs (set these in the Supabase dashboard Vault, not here):
--   app.settings.supabase_url         e.g. https://<ref>.supabase.co
--   app.settings.service_role_key     service role JWT
--
-- Why pg_net instead of direct Edge Function cron:
--   Gives you a row in net._http_response per invocation for audit/debugging.
--   Supabase's new Cron UI is a thin wrapper around this — you can manage the
--   same jobs from the dashboard.
create extension if not exists pg_cron;

create extension if not exists pg_net;

-- Helper that invokes an Edge Function with the service_role key.
create or replace function star_vault.invoke_edge_function (
  function_name text,
  payload jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer as $$
declare
  v_url text := current_setting('app.settings.supabase_url', true)
                || '/functions/v1/' || function_name;
  v_key text := current_setting('app.settings.service_role_key', true);
  v_request_id bigint;
begin
  if v_url is null or v_key is null then
    raise exception
      'app.settings.supabase_url or app.settings.service_role_key not set';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type',  'application/json'
    ),
    body := payload,
    timeout_milliseconds := 390000  -- just under Edge Function 400s cap
  ) into v_request_id;

  return v_request_id;
end;
$$;

grant
execute on function star_vault.invoke_edge_function (text, jsonb) to service_role;

-- Unschedule before scheduling (idempotent on re-apply)
do $$
begin
  perform cron.unschedule('star-vault-sync-stars')       where exists (select 1 from cron.job where jobname = 'star-vault-sync-stars');
  perform cron.unschedule('star-vault-sync-content')     where exists (select 1 from cron.job where jobname = 'star-vault-sync-content');
  perform cron.unschedule('star-vault-sync-embeddings')  where exists (select 1 from cron.job where jobname = 'star-vault-sync-embeddings');
  perform cron.unschedule('star-vault-reconcile-weekly') where exists (select 1 from cron.job where jobname = 'star-vault-reconcile-weekly');
exception when undefined_function then
  null;  -- cron.unschedule(text) may not exist on older pg_cron; fall through
end $$;

-- Stagger the three hourly jobs so they don't all hit GitHub at the same time
-- and compete for the same pg_net worker slot.
select
  cron.schedule (
    'star-vault-sync-stars',
    '3 * * * *', -- :03 past each hour
    $$ select star_vault.invoke_edge_function('sync-stars'); $$
  );

select
  cron.schedule (
    'star-vault-sync-content',
    '13 * * * *', -- :13 past each hour
    $$ select star_vault.invoke_edge_function('sync-content'); $$
  );

select
  cron.schedule (
    'star-vault-sync-embeddings',
    '23 * * * *', -- :23 past each hour
    $$ select star_vault.invoke_edge_function('sync-embeddings'); $$
  );

-- Weekly authoritative reconcile: Sundays at 04:33 UTC. Deletions are STILL
-- gated by isSafeToReconcile() inside the function; scheduling does not
-- imply approval. Forces useEtags=false via query param.
select
  cron.schedule (
    'star-vault-reconcile-weekly',
    '33 4 * * 0',
    $$ select star_vault.invoke_edge_function('sync-stars', jsonb_build_object('reconcile', true)); $$
  );

comment on function star_vault.invoke_edge_function (text, jsonb) is 'Invoke a star_vault Edge Function via pg_net. Reads app.settings.supabase_url / service_role_key.';
