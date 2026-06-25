import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("README documents the Codex MCP launcher without leaking secrets", async () => {
  const readme = await readFile(
    resolve(import.meta.dir, "..", "README.md"),
    "utf8",
  );
  const codexSection = readme.slice(
    readme.indexOf("[mcp_servers.star-vault]"),
    readme.indexOf("MCP tools:"),
  );

  expect(readme).toContain("[mcp_servers.star-vault]");
  expect(readme).toContain(
    'args = ["run", "--cwd", "/Users/workboi/projects/star-vault", "mcp"]',
  );
  expect(readme).toContain('"SUPABASE_SCHEMA" = "star_vault"');
  expect(codexSection).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  expect(codexSection).not.toContain("OPENAI_API_KEY");
  expect(readme).not.toContain("/Users/bigmac/projects/personal/star-vault");
});
