-- Migration: Sync infrastructure for ETag caching, run tracking, and
-- idempotent embeddings. Layered on top of 0014 canonical.
--
-- Adds:
--   * star_vault.github_etags       -- per-URL ETag / Last-Modified cache
--   * star_vault.sync_runs          -- one row per sync invocation
--   * star_vault.repos.seen_at      -- last sync run that observed this repo
--   * star_vault.repos.embedding_input_hash -- skip re-embedding unchanged rows
--   * star_vault.repos.embedding_model / embedding_dim -- embed-model audit
--   * RLS enabled (no policies => deny-by-default; service_role bypasses)
set
  search_path = public,
  extensions;

-- -- -- github_etags -------------------------------------------------------
create table if not exists star_vault.github_etags (
  url text primary key,
  etag text,
  last_modified text,
  status int,
  fetched_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists github_etags_updated_at_idx on star_vault.github_etags (updated_at desc);

comment on table star_vault.github_etags is 'Per-URL ETag cache. A 304 on these URLs does not count against the GitHub primary rate limit.';

-- -- -- sync_runs ----------------------------------------------------------
-- One row per sync invocation. The orchestrator sets status=running at the
-- start and completed/failed at the end. Reconciliation deletes only happen
-- when the latest run with kind=reconcile has status=completed and
-- safety_ok=true.
create table if not exists star_vault.sync_runs (
  id bigserial primary key,
  started_at timestamptz default now(),
  completed_at timestamptz,
  kind text not null check (
    kind in (
      'stars',
      'content',
      'embeddings',
      'reconcile',
      'full'
    )
  ),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  pages_walked int default 0,
  pages_304 int default 0,
  repos_seen int default 0,
  repos_deleted int default 0,
  content_fetched int default 0,
  embeddings_generated int default 0,
  safety_ok boolean,
  error_message text,
  metadata jsonb
);

create index if not exists sync_runs_started_at_idx on star_vault.sync_runs (started_at desc);

create index if not exists sync_runs_kind_status_idx on star_vault.sync_runs (kind, status);

comment on table star_vault.sync_runs is 'One row per sync invocation. Reconcile deletes are gated on a completed+safe run.';

-- -- -- repos columns ------------------------------------------------------
alter table star_vault.repos
add column if not exists seen_at bigint,
add column if not exists embedding_input_hash text,
add column if not exists embedding_model text default 'text-embedding-3-small',
add column if not exists embedding_dim int default 1536;

create index if not exists repos_seen_at_idx on star_vault.repos (seen_at);

comment on column star_vault.repos.seen_at is 'star_vault.sync_runs.id of the most recent run that observed this repo via /user/starred. Rows not matching the latest completed reconcile run are candidates for deletion.';

comment on column star_vault.repos.embedding_input_hash is 'SHA-256 hex of the exact input string used to generate the current embedding. Re-embed only when this changes.';

-- -- -- RLS: deny-by-default, service_role bypasses ------------------------
-- No policies => only service_role (which bypasses RLS) can read/write.
alter table star_vault.repos enable row level security;

alter table star_vault.sync_state enable row level security;

alter table star_vault.sync_runs enable row level security;

alter table star_vault.github_etags enable row level security;

-- -- -- grants consistent with 0014 ---------------------------------------
grant all on star_vault.github_etags to service_role;

grant all on star_vault.sync_runs to service_role;

grant all on all sequences in schema star_vault to service_role;
