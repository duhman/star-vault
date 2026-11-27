import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const script = join(repoRoot, "scripts", "deploy-edge-function.sh");

let stubDir: string;
let callLog: string;

// scp and ssh are replaced by stubs that only record their arguments, so the
// script can never reach a real host from this test.
beforeEach(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "star-vault-deploy-"));
  callLog = join(stubDir, "calls.log");
  for (const name of ["scp", "ssh"]) {
    const stub = join(stubDir, name);
    await writeFile(stub, `#!/bin/bash\necho "${name} $*" >> "${callLog}"\n`);
    await chmod(stub, 0o755);
  }
});

afterEach(async () => {
  await rm(stubDir, { recursive: true, force: true });
});

async function runDeploy(server: string | undefined) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${stubDir}:${process.env.PATH}`,
  };
  delete env.SERVER;
  if (server !== undefined) env.SERVER = server;

  const proc = Bun.spawn(["bash", script, "sync-stars"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  const calls = await readFile(callLog, "utf8").catch(() => "");
  return { exitCode, stderr, calls };
}

test.each([
  ["unset", undefined],
  ["empty", ""],
])("deploy script refuses to run when SERVER is %s", async (_label, server) => {
  const { exitCode, stderr, calls } = await runDeploy(server);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("SERVER");
  // The message has to say where Supabase Cloud deploys go instead.
  expect(stderr).toContain("bun run deploy:cron");
  expect(calls).toBe("");
});

test("deploy script targets only the SERVER it is given", async () => {
  const { exitCode, calls } = await runDeploy("supabase.example.invalid");

  expect(exitCode).toBe(0);
  expect(calls).toContain("root@supabase.example.invalid");
  expect(calls).not.toContain("hstgr.cloud");
});

test("deploy script names no retired host", async () => {
  const source = await readFile(script, "utf8");

  expect(source).not.toContain("srv1209224");
  expect(source).not.toContain("hstgr.cloud");
});

// The file is not executable (mode 100644), so the usage line must go through bash.
test("deploy script documents an invocation that works", async () => {
  const source = await readFile(script, "utf8");

  expect(source).toContain("bash scripts/deploy-edge-function.sh");
  expect(source).not.toContain("./scripts/deploy-edge-function.sh");
});
