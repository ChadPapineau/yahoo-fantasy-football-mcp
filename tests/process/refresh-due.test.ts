// refresh-due.test.ts — the refresh tick as launchd runs it, a real `ff refresh due` process every 15
// minutes (season-fresh §4.1): when nothing is due the process exits 0 in well under a second and
// makes no request at all (the client logs every request at debug level: none appears), and it still
// records its heartbeat. Fixture mode, a temp HOME and cache; `dist/cli.js` when
// FF_PROCESS_TEST_DIST=1 (the CI process job, after `npm run build`), else src/cli.ts through tsx —
// the sub-second budget is asserted on the built package only (tsx compiles at startup).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST = path.join(ROOT, "dist", "cli.js");
const USE_DIST = process.env.FF_PROCESS_TEST_DIST === "1";
const TSX = import.meta.resolve("tsx");
/** A no-op tick's budget on the built package (spec §4.1: "well under 1 s"). */
const NO_OP_BUDGET_MS = 1_000;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempRoot(): { dir: string; env: Record<string, string> } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-tick-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return {
    dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(dir, "home"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      FF_CONFIG_DIR: path.join(dir, "config"),
      FF_CACHE_DIR: path.join(dir, "cache"),
      FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
      FF_LEAGUE_FILE: path.join(ROOT, "fixtures", "manual", "league.yaml"),
      FF_WEATHER_SOURCE: "off",
      FF_LOG_LEVEL: "debug",
    },
  };
}

function ff(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): { code: number | null; stdout: string; stderr: string; ms: number } {
  const argv = USE_DIST
    ? [DIST, ...args]
    : ["--import", TSX, path.join(ROOT, "src", "cli.ts"), ...args];
  const t0 = performance.now();
  const r = spawnSync(process.execPath, argv, { env, cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t0 };
}

const requests = (stderr: string): string[] =>
  stderr.split("\n").filter((l) => /"event":"http\.(get|redirect|error)"/.test(l));

describe("ff refresh due (process)", () => {
  it("nothing due: exit 0, zero requests, the heartbeat recorded, well under a second", () => {
    const t = tempRoot();
    // the first tick on a fresh install repairs every source (schedules first)
    const first = ff(["refresh", "due"], t.env, t.dir);
    expect(first.code, first.stderr).toBe(0);
    expect(requests(first.stderr).length).toBeGreaterThan(0);
    expect(first.stdout).toMatch(/nflverse:schedules\s+due repair/);

    // the next tick, moments later: everything was just checked (the 14-minute politeness gap)
    const second = ff(["refresh", "due"], t.env, t.dir);
    expect(second.code, second.stderr).toBe(0);
    expect(requests(second.stderr)).toEqual([]);
    expect(second.stdout).toMatch(/nflverse:schedules\s+not_due min_gap next /);
    expect(second.stdout).not.toMatch(/ published | FAILED /);
    if (USE_DIST) expect(second.ms).toBeLessThan(NO_OP_BUDGET_MS);

    const db = new DatabaseSync(path.join(t.env.FF_CACHE_DIR ?? "", "store.sqlite"), {
      readOnly: true,
    });
    try {
      expect(db.prepare("SELECT job, exit, summary FROM job_run").all()).toEqual([
        {
          job: "refresh-due",
          exit: 0,
          summary: "due=0 published=0 unchanged=0 skipped=0 failed=0",
        },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM job_lock").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 120_000);

  it("--dry-run --json: the decisions, no request, nothing written", () => {
    const t = tempRoot();
    const r = ff(["refresh", "due", "--dry-run", "--json"], t.env, t.dir);
    expect(r.code, r.stderr).toBe(0);
    expect(requests(r.stderr)).toEqual([]);
    const doc = JSON.parse(r.stdout) as { target: string; decisions: { reason: string }[] };
    expect(doc.target).toBe("due");
    expect(doc.decisions.map((d) => d.reason)).toEqual([
      "repair",
      "repair",
      "repair",
      "repair",
      "not_due",
    ]);
  }, 60_000);
});
