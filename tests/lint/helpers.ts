// helpers.ts — shared fixtures for the scaffold's self-tests (docs/plan/05 §2 "adversarial by
// default"; plan 10 §3.0 Z3): temporary fake projects and a runner for the scripts/ci checks.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * A fresh temporary directory; `cleanup()` removes it. Real path: on macOS os.tmpdir() is behind a
 * /var -> /private/var symlink, and resolvers report real paths.
 */
export function tempDir(prefix = "ff-scaffold-"): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write `files` (relative path -> contents; objects are JSON-encoded) under `dir`. */
export function writeTree(dir: string, files: Record<string, string | object>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
}

/** A minimal fake project whose runtime deps are the given installed packages. */
export function fakeProject(
  dir: string,
  deps: Record<string, Record<string, unknown>>,
  extra: Record<string, string | object> = {},
): void {
  const files: Record<string, string | object> = {
    "package.json": {
      name: "fake-project",
      version: "1.0.0",
      private: true,
      dependencies: Object.fromEntries(
        Object.entries(deps).map(([n, m]) => [
          n,
          typeof m.version === "string" ? m.version : "1.0.0",
        ]),
      ),
    },
    ...extra,
  };
  for (const [name, manifest] of Object.entries(deps)) {
    files[`node_modules/${name}/package.json`] = { name, version: "1.0.0", ...manifest };
  }
  writeTree(dir, files);
}

/** Run a scripts/ci/*.mjs check as a child process (argument array, no shell). */
export function runCheck(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ci", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
