-- Migration: Rewrite star_vault.invoke_edge_function to read the service
-- role key from Supabase Vault instead of app.settings.* GUCs.
--
-- Why the change:
--   Supabase Cloud locked down `ALTER DATABASE ... SET` for custom
--   app.settings.* parameters. Even the dashboard SQL editor gets
--   "42501: permission denied to set parameter". The sanctioned path
--   for secrets on managed Postgres is Supabase Vault (vault schema,
--   accessed via vault.decrypted_secrets).
--
-- What you need to do ONCE (outside migrations, via `supabase db query`
-- or the dashboard SQL editor — works in both):
--   select vault.create_secret(
--     '<service_role_jwt>',
--     'star_vault_service_role_key',
--     'Service role JWT for pg_cron to invoke star_vault Edge Functions'
--   );
--
-- The URL is hardcoded as a constant because it's the public project
-- URL (not a secret). Update this migration if you ever migrate the
-- project to a different ref.
--
-- Keeps the existing 2-arg signature (text, jsonb) so existing pg_cron
-- jobs scheduled against invoke_edge_function continue to resolve.
set
  search_path = public,
  extensions;

create or replace function star_vault.invoke_edge_function (
  function_name text,
  payload jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer as $$
declare
  v_url text := 'https://brawengrbiuvnmsyqhoe.supabase.co/functions/v1/' || function_name;
  v_key text;
  v_request_id bigint;
begin
  -- Read the service-role key from Vault. Fails loudly if missing.
  select decrypted_secret
    into v_key
    from vault.decrypted_secrets
   where name = 'star_vault_service_role_key'
   limit 1;

  if v_key is null then
    raise exception
      'star_vault_service_role_key not found in vault.secrets. Run: select vault.create_secret(''<jwt>'', ''star_vault_service_role_key'', ''...'')';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type',  'application/json'
    ),
    body := payload,
    timeout_milliseconds := 390000
  ) into v_request_id;

  return v_request_id;
end;
$$;

grant
execute on function star_vault.invoke_edge_function (text, jsonb) to service_role;

comment on function star_vault.invoke_edge_function (text, jsonb) is 'Invoke a star_vault Edge Function via pg_net. Reads the service-role JWT from vault.decrypted_secrets (name: star_vault_service_role_key). Project URL is hardcoded for brawengrbiuvnmsyqhoe.';
