// Deno mirror of src/shared/starVault.ts. Keep in sync.
// Why mirrored: Edge Functions run on Deno; bundling src/ through esbuild
// adds a build step without a commensurate benefit for three ~200-line
// handlers. Drift risk is flagged via shared types below + a typecheck in CI.

export const STAR_VAULT_SCHEMA = "star_vault";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export const REPOS_TABLE = "repos";
export const SYNC_RUNS_TABLE = "sync_runs";
export const ETAGS_TABLE = "github_etags";

export const EMBEDDING_BATCH_SIZE = 96;
export const CONTENT_BATCH_LIMIT = 50;
export const EMBEDDING_BATCH_LIMIT = 200;
