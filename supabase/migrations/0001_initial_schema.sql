-- Star Vault: GitHub Stars Intelligence System
-- Initial schema with pgvector support
-- Create schema
create schema if not exists star_vault;

-- Starred repositories
create table star_vault.repos (
  id bigserial primary key,
  github_id bigint unique not null,
  full_name text unique not null, -- owner/repo
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
  readme_content text, -- Full README markdown
  package_json jsonb, -- Parsed package.json for JS/TS repos
  raw_data jsonb, -- Full API response for future use
  fetched_at timestamptz default now(),
  content_fetched_at timestamptz, -- When README/package.json was fetched
  embedding vector (1536), -- OpenAI text-embedding-3-small
  constraint repos_full_name_check check (full_name ~ '^[^/]+/[^/]+$')
);

-- Sync tracking
create table star_vault.sync_state (
  id bigserial primary key,
  last_sync_at timestamptz default now(),
  repos_added integer default 0,
  repos_updated integer default 0,
  content_fetched integer default 0,
  embeddings_generated integer default 0,
  sync_type text default 'manual', -- 'manual', 'cron', 'initial'
  metadata jsonb
);

-- HNSW index for semantic search (same config as tweet-vault)
create index repos_embedding_hnsw_idx on star_vault.repos using hnsw (embedding vector_cosine_ops)
with
  (m = 16, ef_construction = 64);

-- Query indexes
create index repos_language_idx on star_vault.repos (language);

create index repos_starred_at_idx on star_vault.repos (starred_at desc);

create index repos_topics_idx on star_vault.repos using gin (topics);

create index repos_owner_idx on star_vault.repos (owner);

create index repos_fetched_at_idx on star_vault.repos (fetched_at desc);

-- Semantic search function
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
        1 - (r.embedding <=> query_embedding) as similarity
    from star_vault.repos r
    where r.embedding is not null
      and 1 - (r.embedding <=> query_embedding) > match_threshold
    order by r.embedding <=> query_embedding
    limit match_count;
$$;

-- Get repo with full details
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

-- Get stats
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

-- Grant permissions
grant usage on schema star_vault to service_role;

grant all on all tables in schema star_vault to service_role;

grant all on all sequences in schema star_vault to service_role;

grant
execute on all functions in schema star_vault to service_role;

-- Add comment for documentation
comment on schema star_vault is 'GitHub Stars Intelligence System - semantic search over starred repositories';
