import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("MCP server uses registerTool instead of deprecated tool overloads", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "..", "mcp-server/index.ts"),
    "utf8",
  );

  expect(source).toContain("server.registerTool(");
  expect(source).not.toContain("server.tool(");
  expect(source).toContain("inputSchema: z.object");
});
