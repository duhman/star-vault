-- Migration: Make embedding provider and freshness state explicit.
--
-- Why:
--   Star Vault can now embed with either OpenAI or Gemini. Those vectors must
--   never be searched in the same vector space by accident. Content and source
--   changes also need a cheap, deterministic way to enqueue re-embedding.

set
  search_path = public,
  extensions;

alter table star_vault.repos
add column if not exists embedding_provider text default 'openai',
add column if not exists embedding_generated_at timestamptz,
add column if not exists content_checked_at timestamptz,
add column if not exists content_changed_at timestamptz,
add column if not exists source_changed_at timestamptz,
add column if not exists needs_embedding boolean not null default true;

update star_vault.repos
set
  embedding_provider = coalesce(embedding_provider, 'openai'),
  embedding_dim = coalesce(embedding_dim, 1536),
  embedding_model = coalesce(embedding_model, 'text-embedding-3-small'),
  embedding_generated_at = case
    when embedding is not null and embedding_generated_at is null then coalesce(fetched_at, now())
    else embedding_generated_at
  end,
  content_checked_at = coalesce(content_checked_at, content_fetched_at),
  content_changed_at = case
    when content_changed_at is null and (readme_content is not null or package_json is not null)
      then content_fetched_at
    else content_changed_at
  end,
  source_changed_at = coalesce(source_changed_at, fetched_at),
  needs_embedding = case
    when embedding is not null and embedding_input_hash is not null then false
    else true
  end;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'repos_embedding_provider_check'
       and conrelid = 'star_vault.repos'::regclass
  ) then
    alter table star_vault.repos
      add constraint repos_embedding_provider_check
      check (embedding_provider in ('openai', 'gemini'));
  end if;
end
$$;

create index if not exists repos_embedding_provider_idx
  on star_vault.repos (embedding_provider, embedding_model, embedding_dim);

create index if not exists repos_needs_embedding_idx
  on star_vault.repos (needs_embedding, starred_at desc);

create index if not exists repos_content_checked_at_idx
  on star_vault.repos (content_checked_at asc nulls first);

-- Recreate the upsert RPC so source metadata changes raise needs_embedding.
create or replace function star_vault.upsert_repos (payload jsonb, run_id bigint default null) returns table (added int, updated int) language plpgsql as $$
declare
  v_added   int := 0;
  v_updated int := 0;
begin
  with raw as (
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
      item -> 'raw_data'                                     as raw_data,
      ordinality                                             as ord
    from jsonb_array_elements(payload) with ordinality as t(item, ordinality)
  ),
  input as (
    select distinct on (github_id) *
    from raw
    order by github_id, ord
  ),
  upserted as (
    insert into star_vault.repos as r (
      github_id, full_name, owner, name, description, topics, language,
      stargazers_count, forks_count, license, html_url, default_branch,
      starred_at, raw_data, fetched_at, seen_at, source_changed_at,
      needs_embedding
    )
    select
      i.github_id, i.full_name, i.owner, i.name, i.description, i.topics,
      i.language, i.stargazers_count, i.forks_count, i.license, i.html_url,
      i.default_branch, i.starred_at, i.raw_data, now(), run_id, now(), true
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
      seen_at          = coalesce(run_id, r.seen_at),
      source_changed_at = case
        when
          r.full_name is distinct from excluded.full_name or
          r.description is distinct from excluded.description or
          r.topics is distinct from excluded.topics or
          r.language is distinct from excluded.language or
          r.stargazers_count is distinct from excluded.stargazers_count or
          r.forks_count is distinct from excluded.forks_count or
          r.license is distinct from excluded.license or
          r.default_branch is distinct from excluded.default_branch
        then now()
        else r.source_changed_at
      end,
      needs_embedding = r.needs_embedding or (
        r.full_name is distinct from excluded.full_name or
        r.description is distinct from excluded.description or
        r.topics is distinct from excluded.topics or
        r.language is distinct from excluded.language or
        r.stargazers_count is distinct from excluded.stargazers_count or
        r.forks_count is distinct from excluded.forks_count or
        r.license is distinct from excluded.license or
        r.default_branch is distinct from excluded.default_branch
      )
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

comment on function star_vault.upsert_repos (jsonb, bigint) is 'Bulk upsert starred repos; deduplicates on github_id, returns added/updated counts, and raises needs_embedding when source metadata changes.';

grant execute on function star_vault.upsert_repos (jsonb, bigint) to service_role;

drop function if exists star_vault.search_repos (vector (1536), float, int);
drop function if exists star_vault.search_repos (vector (1536), float, int, text, text, int);

create or replace function star_vault.search_repos (
  query_embedding vector (1536),
  match_threshold float default 0.7,
  match_count int default 10,
  embedding_provider_filter text default 'openai',
  embedding_model_filter text default 'text-embedding-3-small',
  embedding_dim_filter int default 1536
) returns table (
  id bigint,
  full_name text,
  description text,
  topics text[],
  language text,
  html_url text,
  stargazers_count integer,
  forks_count integer,
  starred_at timestamptz,
  content_fetched_at timestamptz,
  content_checked_at timestamptz,
  content_changed_at timestamptz,
  source_changed_at timestamptz,
  embedding_provider text,
  embedding_model text,
  embedding_dim int,
  embedding_generated_at timestamptz,
  similarity float
) language plpgsql stable as $$
begin
  perform set_config('hnsw.ef_search', '100', true);

  return query
    select
      r.id,
      r.full_name,
      r.description,
      r.topics,
      r.language,
      r.html_url,
      r.stargazers_count,
      r.forks_count,
      r.starred_at,
      r.content_fetched_at,
      r.content_checked_at,
      r.content_changed_at,
      r.source_changed_at,
      r.embedding_provider,
      r.embedding_model,
      r.embedding_dim,
      r.embedding_generated_at,
      (-(r.embedding <#> query_embedding))::float as similarity
    from star_vault.repos r
    where r.embedding is not null
      and r.embedding_provider = embedding_provider_filter
      and r.embedding_model = embedding_model_filter
      and r.embedding_dim = embedding_dim_filter
      and (-(r.embedding <#> query_embedding)) > match_threshold
    order by r.embedding <#> query_embedding
    limit match_count;
end;
$$;

grant execute on function star_vault.search_repos (vector (1536), float, int, text, text, int) to service_role;
