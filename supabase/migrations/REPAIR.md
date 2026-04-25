# Migration History Repair

Migrations `0003`–`0013` were empty placeholders inserted to make the local
migration tree match the remote `supabase_migrations.schema_migrations` table.
They have been removed from source.

To reconcile a remote database that still has those ghost entries:

```bash
# Mark the ghost entries as already applied so the CLI stops complaining
for ts in 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013; do
  supabase migration repair --status applied "${ts}"
done

# Verify local and remote agree
supabase migration list
```

Alternatively, if you control the remote and want a clean slate, delete the
rows directly from `supabase_migrations.schema_migrations` for timestamps
`0003`–`0013`. `migration repair` is the sanctioned path.

## Canonical structure is owned by 0014

`0014_reconcile_star_vault_canonical.sql` is idempotent and defines the
authoritative shape of `star_vault.*`. Later migrations (`0015+`) layer on top.
