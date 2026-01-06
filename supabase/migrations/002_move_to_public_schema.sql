-- Migration: Move from star_vault schema to public schema
-- Reason: PostgREST only exposes public schema by default on self-hosted Supabase
-- Drop the star_vault schema objects (they're empty anyway)
drop schema if exists star_vault cascade;

-- Create tables in public schema with sv_ prefix for namespacing
-- Starred repositories
create table if not exists sv_repos (
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
  readme_content text, -- Full README
  package_json jsonb, -- Parsed package.json
  raw_data jsonb, -- Full API response
  fetched_at timestamptz default now(),
  content_fetched_at timestamptz, -- When README/package.json was fetched
  embedding vector (1536),
  constraint sv_repos_full_name_check check (full_name ~ '^[^/]+/[^/]+$')
);

-- Sync tracking
create table if not exists sv_sync_state (
  id bigserial primary key,
  last_sync_at timestamptz default now(),
  repos_added integer default 0,
  repos_updated integer default 0,
  content_fetched integer default 0,
  embeddings_generated integer default 0,
  sync_type text default 'manual',
  metadata jsonb
);

-- HNSW index for semantic search
create index if not exists sv_repos_embedding_hnsw_idx on sv_repos using hnsw (embedding vector_cosine_ops)
with
  (m = 16, ef_construction = 64);

-- Query indexes
create index if not exists sv_repos_language_idx on sv_repos (language);

create index if not exists sv_repos_starred_at_idx on sv_repos (starred_at desc);

create index if not exists sv_repos_topics_idx on sv_repos using gin (topics);

create index if not exists sv_repos_content_fetched_at_idx on sv_repos (content_fetched_at);

-- Search function (public schema)
create or replace function sv_search_repos (
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
  similarity float
) language sql stable as $$
    select
        r.id,
        r.full_name,
        r.description,
        r.topics,
        r.language,
        r.html_url,
        1 - (r.embedding <=> query_embedding) as similarity
    from sv_repos r
    where r.embedding is not null
      and 1 - (r.embedding <=> query_embedding) > match_threshold
    order by r.embedding <=> query_embedding
    limit match_count;
$$;

-- Get repo details by full_name
create or replace function sv_get_repo_details (p_full_name text) returns table (
  id bigint,
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
  readme_content text,
  starred_at timestamptz
) language sql stable as $$
    select
        r.id,
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
        r.readme_content,
        r.starred_at
    from sv_repos r
    where r.full_name = p_full_name;
$$;

-- Get vault statistics
create or replace function sv_get_stats () returns table (
  total_repos bigint,
  repos_with_embeddings bigint,
  repos_with_content bigint,
  languages_count bigint,
  last_sync timestamptz
) language sql stable as $$
    select
        count(*) as total_repos,
        count(*) filter (where embedding is not null) as repos_with_embeddings,
        count(*) filter (where content_fetched_at is not null) as repos_with_content,
        count(distinct language) filter (where language is not null) as languages_count,
        (select max(last_sync_at) from sv_sync_state) as last_sync
    from sv_repos;
$$;
