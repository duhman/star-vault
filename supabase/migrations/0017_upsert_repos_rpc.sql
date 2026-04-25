-- Migration: Single-RPC upsert that returns added/updated counts + tags the
-- sync run that observed each row.
--
-- Replaces the client's SELECT-then-UPSERT pattern, which:
--   1. Costs two round-trips per batch.
--   2. Is racy under concurrent sync (rare for a personal project, but still).
--
-- Uses the `xmax = 0` idiom: on an INSERT, xmax is 0; on an UPDATE from
-- ON CONFLICT, xmax is the original tuple's transaction ID. This lets a single
-- INSERT ... ON CONFLICT ... RETURNING distinguish the two cases.
--
-- Postgres 18 replaces this with `RETURNING (OLD IS NULL)` — if Supabase moves
-- to PG18 the function body changes but the signature stays.
set
  search_path = public,
  extensions;

create or replace function star_vault.upsert_repos (payload jsonb, run_id bigint default null) returns table (added int, updated int) language plpgsql as $$
declare
  v_added   int := 0;
  v_updated int := 0;
begin
  with input as (
    select
      (item ->> 'github_id')::bigint                         as github_id,
      item ->> 'full_name'                                   as full_name,
      item ->> 'owner'                                       as owner,
      item ->> 'name'                                        as name,
      item ->> 'description'                                 as description,
      coalesce(
        array(select jsonb_array_elements_text(item -> 'topics')),
        '{}'::text[]
      )                                                      as topics,
      item ->> 'language'                                    as language,
      nullif(item ->> 'stargazers_count', '')::int           as stargazers_count,
      nullif(item ->> 'forks_count', '')::int                as forks_count,
      item ->> 'license'                                     as license,
      item ->> 'html_url'                                    as html_url,
      coalesce(item ->> 'default_branch', 'main')            as default_branch,
      nullif(item ->> 'starred_at', '')::timestamptz         as starred_at,
      item -> 'raw_data'                                     as raw_data
    from jsonb_array_elements(payload) as item
  ),
  upserted as (
    insert into star_vault.repos as r (
      github_id, full_name, owner, name, description, topics, language,
      stargazers_count, forks_count, license, html_url, default_branch,
      starred_at, raw_data, fetched_at, seen_at
    )
    select
      i.github_id, i.full_name, i.owner, i.name, i.description, i.topics,
      i.language, i.stargazers_count, i.forks_count, i.license, i.html_url,
      i.default_branch, i.starred_at, i.raw_data, now(), run_id
    from input i
    on conflict (github_id) do update set
      full_name        = excluded.full_name,
      owner            = excluded.owner,
      name             = excluded.name,
      description      = excluded.description,
      topics           = excluded.topics,
      language         = excluded.language,
      stargazers_count = excluded.stargazers_count,
      forks_count      = excluded.forks_count,
      license          = excluded.license,
      html_url         = excluded.html_url,
      default_branch   = excluded.default_branch,
      starred_at       = coalesce(excluded.starred_at, r.starred_at),
      raw_data         = excluded.raw_data,
      fetched_at       = now(),
      seen_at          = coalesce(run_id, r.seen_at)
    returning (xmax = 0) as inserted
  )
  select
    count(*) filter (where inserted)       :: int,
    count(*) filter (where not inserted)   :: int
  into v_added, v_updated
  from upserted;

  return query select v_added, v_updated;
end;
$$;

grant
execute on function star_vault.upsert_repos (jsonb, bigint) to service_role;

comment on function star_vault.upsert_repos (jsonb, bigint) is 'Bulk upsert starred repos. Returns (added, updated) using the xmax=0 idiom. If run_id is provided, tags each row with seen_at = run_id for reconciliation.';
