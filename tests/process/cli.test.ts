// cli.test.ts — process tests for the non-serve `ff` subcommands (plan 05 §1 process level, §4.2;
// plan 10 A13): spawn the real CLI (src/cli.ts through tsx; `dist/cli.js` when
// FF_PROCESS_TEST_DIST=1, as the CI process job does after `npm run build`) with a temp HOME and temp
// FF_CONFIG_DIR/FF_CACHE_DIR, so nothing touches the real ~/.config, ~/.cache or LaunchAgents.
// Refresh runs in fixture mode (FF_FIXTURE_DIR): the fixture tree is the only transport, so no test
// reaches the network. launchctl is never run: install-launchd/uninstall use --dry-run only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST = path.join(ROOT, "dist", "cli.js");
const USE_DIST = process.env.FF_PROCESS_TEST_DIST === "1";
const TSX = import.meta.resolve("tsx");

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempRoot(): { dir: string; home: string; env: Record<string, string> } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-proc-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = path.join(dir, "home");
  return {
    dir,
    home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      FF_CONFIG_DIR: path.join(dir, "config"),
      FF_CACHE_DIR: path.join(dir, "cache"),
    },
  };
}

/** Runs `ff <args>` as a child process with exactly `env` (no inherited FF_* or CLAUDECODE). */
function ff(args: readonly string[], env: Record<string, string>, cwd: string): Run {
  const argv = USE_DIST
    ? [DIST, ...args]
    : ["--import", TSX, path.join(ROOT, "src", "cli.ts"), ...args];
  const r = spawnSync(process.execPath, argv, { env, cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const fixtureEnv = {
  FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
  FF_LEAGUE_FILE: path.join(ROOT, "fixtures", "manual", "league.yaml"),
};

describe("ff (process)", () => {
  it("version: exit 0, one line on stdout, nothing on stderr", () => {
    const t = tempRoot();
    const r = ff(["version"], t.env, t.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ff \d+\.\d+\.\d+ \(node \d+\.\d+\.\d+\)\n$/);
    expect(r.stderr).toBe("");
  });

  it("usage errors exit 2 with the message on stderr and nothing on stdout", () => {
    const t = tempRoot();
    for (const args of [[], ["nope"], ["status", "--bogus"], ["refresh"]]) {
      const r = ff(args, t.env, t.dir);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr.length).toBeGreaterThan(0);
    }
  });

  it("print-config: valid JSON with absolute, existing paths and no secret value (or exit 1 when unbuilt)", () => {
    const t = tempRoot();
    const planted = "process-test-planted-value-42";
    const r = ff(
      ["print-config", "--client", "desktop"],
      { ...t.env, YAHOO_CLIENT_SECRET: planted, ODDS_API_KEY: planted },
      t.dir,
    );
    expect(r.stdout + r.stderr).not.toContain(planted);
    if (!existsSync(DIST)) {
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("npm run build");
      return;
    }
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const e = j.mcpServers["fantasy-football-mcp-server"];
    expect(e?.command).toBe(process.execPath);
    expect(e?.args).toEqual([DIST, "serve"]);
    for (const p of [e?.command ?? "", e?.args[0] ?? ""])
      expect(path.isAbsolute(p) && existsSync(p)).toBe(true);
    expect(Object.keys(e?.env ?? {})).not.toContain("YAHOO_CLIENT_SECRET");
  });

  it("doctor --json on a fresh temp config/cache: exit 1, every row present, Yahoo rows n/a, JSON only on stdout", () => {
    const t = tempRoot();
    const r = ff(["doctor", "--json"], t.env, t.dir);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout) as {
      exit_code: number;
      rows: { id: string; n: number; status: string; message: string }[];
    };
    expect(j.exit_code).toBe(1);
    expect(new Set(j.rows.map((x) => x.n))).toEqual(
      new Set([0, ...Array.from({ length: 22 }, (_, i) => i + 1)]),
    );
    for (const id of [
      "token_file",
      "client_secret",
      "clock_skew",
      "token_validity",
      "provisioning",
      "listener",
    ]) {
      const row = j.rows.find((x) => x.id === id);
      expect(row?.status, id).toBe("na");
      expect(row?.message, id).toContain("no Yahoo access");
    }
    expect(j.rows.find((x) => x.id === "datasets")?.status).toBe("fail");
    expect(j.rows.find((x) => x.id === "league_file")?.status).toBe("fail");
    // doctor never creates the store or the directories
    expect(existsSync(t.env.FF_CACHE_DIR ?? "")).toBe(false);
    expect(existsSync(t.env.FF_CONFIG_DIR ?? "")).toBe(false);
  });

  it("doctor with a bad configuration exits 2", () => {
    const t = tempRoot();
    const r = ff(["doctor", "--json"], { ...t.env, FF_WEATHER_SOURCE: "sunny" }, t.dir);
    expect(r.code).toBe(2);
    expect(
      (JSON.parse(r.stdout) as { rows: { id: string; status: string }[] }).rows[0],
    ).toMatchObject({ id: "config", status: "config" });
  });

  it("refresh (fixture mode) then status: published, then fresh; logs are JSON lines on stderr", () => {
    const t = tempRoot();
    const env = { ...t.env, ...fixtureEnv };
    const r = ff(["refresh", "nflverse:daily", "--seasons", "2026"], env, t.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^nflverse:injuries\s+published/m);
    expect(r.stdout).toMatch(/^nflverse:roster_weekly\s+published/m);
    for (const line of r.stderr.split("\n").filter((l) => l !== ""))
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    const again = ff(["refresh", "nflverse:injuries", "--seasons", "2026"], env, t.dir);
    expect(again.stdout).toMatch(/unchanged/);
    const s = ff(["status", "--json"], env, t.dir);
    expect(s.code).toBe(0);
    const j = JSON.parse(s.stdout) as {
      store: { state: string };
      sources: { source: string; state: string; rows: number | null }[];
    };
    expect(j.store.state).toBe("ok");
    expect(j.sources.find((x) => x.source === "nflverse:injuries")).toMatchObject({
      state: "fresh",
      rows: 744,
    });
    expect(j.sources.find((x) => x.source === "nflverse:schedules")?.state).toBe("never_loaded");
  }, 60_000);

  it("install-launchd --dry-run: absolute paths and calendar entries on stdout; nothing installed", () => {
    const t = tempRoot();
    const r = ff(
      ["install-launchd", "--dry-run", "--jobs", "nflverse-daily,store-backup"],
      t.env,
      t.dir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`<string>${process.execPath}</string>`);
    expect(r.stdout).toContain(`<string>${DIST}</string>`);
    expect(r.stdout).toContain("<string>nflverse:daily</string>");
    expect(r.stdout).toMatch(
      /<key>Hour<\/key>\s*<integer>10<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/,
    );
    expect(r.stdout).toMatch(
      /<key>Weekday<\/key>\s*<integer>0<\/integer>\s*<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>10<\/integer>/,
    );
    expect(r.stdout).toContain(
      path.join(t.home, "Library", "Logs", "fantasy-football-mcp", "nflverse-daily.log"),
    );
    expect(existsSync(path.join(t.home, "Library"))).toBe(false);
  });

  it("uninstall --dry-run --purge: prints, deletes nothing", () => {
    const t = tempRoot();
    const env = { ...t.env, ...fixtureEnv };
    expect(ff(["backup"], env, t.dir).code).toBe(0);
    const r = ff(["uninstall", "--dry-run", "--purge"], env, t.dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `would delete ${path.join(t.env.FF_CACHE_DIR ?? "", "store.sqlite")}`,
    );
    expect(existsSync(path.join(t.env.FF_CACHE_DIR ?? "", "store.sqlite"))).toBe(true);
  }, 60_000);
});
