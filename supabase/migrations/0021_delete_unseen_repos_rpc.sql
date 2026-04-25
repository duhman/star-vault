-- Migration: Expose a single RPC that deletes rows whose seen_at does not
-- match the given run_id, including NULL seen_at (never touched by any sync).
--
-- Why: PostgREST's .neq() filter silently excludes NULL rows, and the
-- combined .or("seen_at.is.null,seen_at.neq.X") filter has proven fragile
-- against our schema-scoped client. An RPC sidesteps the filter DSL entirely
-- and puts the semantics in SQL where they can't be misread.
set
  search_path = public,
  extensions;

create or replace function star_vault.delete_unseen_repos (run_id bigint) returns int language plpgsql as $$
declare
  v_deleted int := 0;
begin
  with deleted as (
    delete from star_vault.repos
    where seen_at is distinct from run_id
    returning 1
  )
  select count(*)::int into v_deleted from deleted;
  return v_deleted;
end;
$$;

grant
execute on function star_vault.delete_unseen_repos (bigint) to service_role;

comment on function star_vault.delete_unseen_repos (bigint) is 'Delete rows whose seen_at is null OR not equal to run_id. Uses IS DISTINCT FROM which treats nulls as distinguishable. Returns deleted row count.';
