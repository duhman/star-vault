-- Migration: Reconcile canonical Star Vault schema in star_vault namespace.
-- This migration is intentionally non-destructive and idempotent.

create extension if not exists vector;
set search_path = public, extensions;

create schema if not exists star_vault;

create table if not exists star_vault.repos (
  id bigserial primary key,
  github_id bigint unique not null,
  full_name text unique not null,
  owner text not null,
  name text not null,
  description text,
  topics text[],
  language text,
  stargazers_count integer,
  forks_count integer,
  license text,
  html_url text not null,
  default_branch text default 'main',
  starred_at timestamptz,
  readme_content text,
  package_json jsonb,
  raw_data jsonb,
  fetched_at timestamptz default now(),
  content_fetched_at timestamptz,
  embedding vector (1536),
  constraint repos_full_name_check check (full_name ~ '^[^/]+/[^/]+$')
);

create table if not exists star_vault.sync_state (
  id bigserial primary key,
  last_sync_at timestamptz default now(),
  repos_added integer default 0,
  repos_updated integer default 0,
  content_fetched integer default 0,
  embeddings_generated integer default 0,
  sync_type text default 'manual',
  metadata jsonb
);

alter table star_vault.repos add column if not exists github_id bigint;
alter table star_vault.repos add column if not exists full_name text;
alter table star_vault.repos add column if not exists owner text;
alter table star_vault.repos add column if not exists name text;
alter table star_vault.repos add column if not exists description text;
alter table star_vault.repos add column if not exists topics text[];
alter table star_vault.repos add column if not exists language text;
alter table star_vault.repos add column if not exists stargazers_count integer;
alter table star_vault.repos add column if not exists forks_count integer;
alter table star_vault.repos add column if not exists license text;
alter table star_vault.repos add column if not exists html_url text;
alter table star_vault.repos add column if not exists default_branch text default 'main';
alter table star_vault.repos add column if not exists starred_at timestamptz;
alter table star_vault.repos add column if not exists readme_content text;
alter table star_vault.repos add column if not exists package_json jsonb;
alter table star_vault.repos add column if not exists raw_data jsonb;
alter table star_vault.repos add column if not exists fetched_at timestamptz default now();
alter table star_vault.repos add column if not exists content_fetched_at timestamptz;
alter table star_vault.repos add column if not exists embedding vector (1536);

create unique index if not exists repos_github_id_key
  on star_vault.repos (github_id);
create unique index if not exists repos_full_name_key
  on star_vault.repos (full_name);
do $$
begin
  begin
    execute
      'create index if not exists repos_embedding_hnsw_idx
         on star_vault.repos using hnsw (embedding)
         with (m = 16, ef_construction = 64)';
  exception
    when undefined_object or feature_not_supported then
      begin
        execute
          'create index if not exists repos_embedding_ivfflat_idx
             on star_vault.repos using ivfflat (embedding vector_l2_ops)
             with (lists = 100)';
      exception
        when others then
          null;
      end;
  end;
end
$$;
create index if not exists repos_language_idx on star_vault.repos (language);
create index if not exists repos_starred_at_idx on star_vault.repos (starred_at desc);
create index if not exists repos_topics_idx on star_vault.repos using gin (topics);
create index if not exists repos_owner_idx on star_vault.repos (owner);
create index if not exists repos_fetched_at_idx on star_vault.repos (fetched_at desc);

drop function if exists star_vault.search_repos(vector (1536), float, int);

create or replace function star_vault.search_repos (
  query_embedding vector (1536),
  match_threshold float default 0.7,
  match_count int default 10
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
  similarity float
) language sql stable as $$
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
        1 - (r.embedding <=> query_embedding) as similarity
    from star_vault.repos r
    where r.embedding is not null
      and 1 - (r.embedding <=> query_embedding) > match_threshold
    order by r.embedding <=> query_embedding
    limit match_count;
$$;

create or replace function star_vault.get_repo_details (repo_full_name text) returns table (
  id bigint,
  github_id bigint,
  full_name text,
  owner text,
  name text,
  description text,
  topics text[],
  language text,
  stargazers_count integer,
  forks_count integer,
  license text,
  html_url text,
  starred_at timestamptz,
  readme_content text,
  package_json jsonb
) language sql stable as $$
    select
        r.id,
        r.github_id,
        r.full_name,
        r.owner,
        r.name,
        r.description,
        r.topics,
        r.language,
        r.stargazers_count,
        r.forks_count,
        r.license,
        r.html_url,
        r.starred_at,
        r.readme_content,
        r.package_json
    from star_vault.repos r
    where r.full_name = repo_full_name;
$$;

create or replace function star_vault.get_stats () returns table (
  total_repos bigint,
  repos_with_embeddings bigint,
  repos_with_readme bigint,
  unique_languages bigint,
  total_stars bigint
) language sql stable as $$
    select
        count(*)::bigint as total_repos,
        count(*) filter (where embedding is not null)::bigint as repos_with_embeddings,
        count(*) filter (where readme_content is not null)::bigint as repos_with_readme,
        count(distinct language)::bigint as unique_languages,
        coalesce(sum(stargazers_count), 0)::bigint as total_stars
    from star_vault.repos;
$$;

grant usage on schema star_vault to service_role;
grant all on all tables in schema star_vault to service_role;
grant all on all sequences in schema star_vault to service_role;
grant execute on all functions in schema star_vault to service_role;
