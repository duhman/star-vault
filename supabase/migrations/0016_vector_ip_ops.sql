-- Migration: Switch HNSW index and search RPC to inner-product ops.
--
-- Why: OpenAI text-embedding-3-small returns unit-normalized vectors. For
-- normalized vectors, inner-product, cosine, and L2 produce identical
-- rankings, but inner-product skips a sqrt and is the fastest.
--
-- Also fixes a latent bug in 0014: the IVFFlat fallback used vector_l2_ops
-- while the HNSW used vector_cosine_ops — if the fallback ever fired, the
-- ranking would silently change. This migration makes them both IP.
--
-- Also sets hnsw.ef_search = 100 inside the search_repos RPC for better
-- recall at ~5k rows (default is 40).
set
  search_path = public,
  extensions;

-- -- -- swap index to IP ops ----------------------------------------------
drop index if exists star_vault.repos_embedding_hnsw_idx;

drop index if exists star_vault.repos_embedding_ivfflat_idx;

do $$
begin
  begin
    execute
      'create index repos_embedding_hnsw_idx
         on star_vault.repos using hnsw (embedding vector_ip_ops)
         with (m = 16, ef_construction = 128)';
  exception
    when undefined_object or feature_not_supported then
      execute
        'create index repos_embedding_ivfflat_idx
           on star_vault.repos using ivfflat (embedding vector_ip_ops)
           with (lists = 100)';
  end;
end
$$;

-- -- -- redefine search_repos with <#> + ef_search --------------------------
-- Note: <#> returns NEGATIVE inner product in pgvector (so smaller == closer).
-- For normalized vectors, similarity = -(embedding <#> query).
--
-- SET LOCAL inside a SQL-language function is awkward; use plpgsql so we can
-- set session-local GUCs before the SELECT.
drop function if exists star_vault.search_repos (vector (1536), float, int);

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
) language plpgsql stable as $$
begin
  -- Bump HNSW candidate list for better recall on small tables.
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
      (-(r.embedding <#> query_embedding))::float as similarity
    from star_vault.repos r
    where r.embedding is not null
      and (-(r.embedding <#> query_embedding)) > match_threshold
    order by r.embedding <#> query_embedding
    limit match_count;
end;
$$;

grant
execute on function star_vault.search_repos (vector (1536), float, int) to service_role;
