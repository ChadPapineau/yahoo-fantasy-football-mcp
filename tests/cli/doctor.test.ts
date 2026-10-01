// doctor.test.ts — plan 05 §2 `cli/doctor`: each row has a passing and a failing case; the --json
// shape is stable; exit code = worst finding; offline mode makes zero network calls (the injected
// fetch throws if called). Plan 03 §5 rows; Yahoo rows are "not applicable".
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  checkClientLog,
  checkClientSecrecy,
  checkConfigDir,
  checkDatasets,
  checkJournal,
  checkLaunchConfig,
  checkLaunchd,
  checkLeagueFile,
  checkNode,
  checkNpmrc,
  checkSettingsFlags,
  checkStaleBuild,
  checkStore,
  checkWriteFlag,
  exitCodeFor,
  newestSourceMtime,
  nodeAtLeastMin,
  parseNodeVersion,
  quickCheckFile,
  renderDoctor,
  runDoctor,
  scanClientConfig,
  tailLines,
  type DoctorReport,
  type DoctorRow,
} from "../../src/cli/doctor.js";
import { EXIT } from "../../src/cli/exit.js";
import { makeLogger } from "../../src/cli/io.js";
import { JOBS, LAUNCHCTL, launchAgentsDir, plistPath } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { SERVER_NAME } from "../../src/cli/print-config.js";
import { openExistingStore, openStore, storeOpenReason } from "../../src/cli/store-access.js";
import { datasetFilePath, storePath } from "../../src/config/paths.js";
import { loadConfig, type Config } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { DS_SCHEMA_VERSION } from "../../src/store/attach.js";
import { fixtureFetch } from "../../src/cli/fixture-fetch.js";
import type { FetchLike } from "../../src/http/client.js";
import {
  copyCache,
  fakeExec,
  FIXTURE_LEAGUE,
  FIXTURES,
  fixtureEnv,
  makeIo,
  ROOT,
  sandbox,
  type Sandbox,
} from "./helpers.js";

const REFRESHED_AT = "2026-09-30T18:00:00.000Z";
let template: Sandbox | undefined;
beforeAll(async () => {
  template = sandbox();
  const io = makeIo(template, { env: fixtureEnv(), clock: fixedClock(REFRESHED_AT) });
  expect(await main(["refresh", "nflverse", "--seasons", "2026"], io)).toBe(EXIT.OK);
}, 60_000);
afterAll(() => {
  template?.cleanup();
});

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

function fresh(opts: { create?: boolean } = {}): Sandbox {
  const s = sandbox(opts);
  sb = s;
  return s;
}

function refreshed(): Sandbox {
  const s = fresh();
  mkdirSync(s.configDir, { mode: 0o700 });
  copyCache(template?.cacheDir ?? "", s.cacheDir);
  return s;
}

function cfg(s: Sandbox, env: Record<string, string> = {}): Config {
  return loadConfig({
    env: { FF_CONFIG_DIR: s.configDir, FF_CACHE_DIR: s.cacheDir, ...env },
    file: undefined,
    home: s.home,
    repoRoot: ROOT,
  });
}

const log = (s: Sandbox) => makeLogger(makeIo(s), "error");

const byId = (rows: readonly DoctorRow[], id: string): DoctorRow => {
  const r = rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
};

/** Writes a Claude Desktop config under the sandbox home. */
function desktopConfig(s: Sandbox, servers: Record<string, unknown>, mode = 0o600): string {
  const file = path.join(
    s.home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  chmodSync(file, mode);
  return file;
}

/** A fake built checkout: .git, src/a.ts, package.json, .npmrc, dist/cli.js. */
function checkout(s: Sandbox, opts: { built?: boolean; npmrc?: string } = {}): string {
  const root = path.join(s.dir, "repo");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(root, "src", "deep", "a.ts"), "export {};\n");
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(
    path.join(root, ".npmrc"),
    opts.npmrc ?? "save-exact=true\nignore-scripts=true # hardening\n",
  );
  if (opts.built !== false) {
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "cli.js"), "");
  }
  return root;
}

describe("row 1 — Node version", () => {
  it("≥ 24.15.0 passes; below fails with the fnm hint", () => {
    expect(checkNode("24.15.0").status).toBe("ok");
    expect(checkNode("v25.0.1").status).toBe("ok");
    expect(checkNode("24.14.9").status).toBe("fail");
    expect(checkNode("22.23.2").fix).toContain("fnm install 24");
    expect(checkNode("garbage").status).toBe("fail");
  });

  it("parseNodeVersion / nodeAtLeastMin", () => {
    expect(parseNodeVersion(" v24.21.0\n")).toEqual([24, 21, 0]);
    expect(parseNodeVersion("24.21")).toBeNull();
    expect(nodeAtLeastMin([24, 15, 0])).toBe(true);
    expect(nodeAtLeastMin([23, 99, 99])).toBe(false);
    expect(nodeAtLeastMin([24, 15, 1])).toBe(true);
  });
});

describe("rows 2, 3, 13 — client configs", () => {
  it("no client config anywhere → warn with the print-config hint", async () => {
    const s = fresh();
    const io = makeIo(s);
    const scans = [
      scanClientConfig("desktop", path.join(s.home, "none.json")),
      scanClientConfig("code", path.join(s.home, ".claude.json")),
    ];
    const r = await checkLaunchConfig(io, scans);
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("print-config");
    expect(checkClientSecrecy(scans).status).toBe("skip");
  });

  it("a correct entry (absolute execPath, existing dist/cli.js, serve) passes", async () => {
    const s = fresh();
    const entry = path.join(s.dir, "dist-cli.js");
    writeFileSync(entry, "");
    const file = desktopConfig(s, {
      [SERVER_NAME]: {
        command: process.execPath,
        args: [entry, "serve"],
        env: { FF_LOG_LEVEL: "info" },
      },
      other: { command: "x" },
    });
    const scan = scanClientConfig("desktop", file);
    expect(scan.others).toBe(1);
    const r = await checkLaunchConfig(makeIo(s, { execPath: process.execPath }), [scan]);
    expect(r.status).toBe("ok");
    expect(checkClientSecrecy([scan]).status).toBe("ok");
  });

  it("relative command, missing entry file, no serve, old node, non-node binary each fail", async () => {
    const s = fresh();
    const script = path.join(s.dir, "node-old");
    writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
    const entry = path.join(s.dir, "x", "dist", "cli.js");
    const cases: [unknown, RegExp][] = [
      [{ command: "node", args: [entry, "serve"] }, /not an absolute path/],
      [
        { command: process.execPath, args: ["dist/cli.js", "serve"] },
        /args\[0\]` is not an absolute/,
      ],
      [{ command: process.execPath, args: [entry, "serve"] }, /does not exist/],
      [{ command: process.execPath, args: [entry] }, /does not contain `serve`/],
      [{ command: path.join(s.dir, "nope"), args: [entry, "serve"] }, /not executable/],
      [{ command: script, args: [entry, "serve"] }, /below 24\.15\.0/],
    ];
    const fx = fakeExec(() => ({ stdout: "v22.23.2\n" }));
    for (const [spec, re] of cases) {
      const file = desktopConfig(s, { [SERVER_NAME]: spec });
      const r = await checkLaunchConfig(makeIo(s, { exec: fx.exec }), [
        scanClientConfig("desktop", file),
      ]);
      expect(r.status, String(re)).toBe("fail");
      expect(r.details.join("\n")).toMatch(re);
    }
    expect(fx.calls.some((c) => c.file === script && c.args[0] === "--version")).toBe(true);
    const silent = fakeExec(() => ({ code: 1 }));
    const file = desktopConfig(s, { [SERVER_NAME]: { command: script, args: [entry, "serve"] } });
    const r = await checkLaunchConfig(makeIo(s, { exec: silent.exec }), [
      scanClientConfig("desktop", file),
    ]);
    expect(r.details.join("\n")).toMatch(/did not report a Node version/);
  });

  it("our entry is found by its dist/cli.js path under any name; invalid JSON is reported", async () => {
    const s = fresh();
    const file = desktopConfig(s, {
      ff: { command: process.execPath, args: ["/a/dist/cli.js", "serve"] },
    });
    expect(scanClientConfig("desktop", file).entries).toHaveLength(1);
    writeFileSync(file, "{not json");
    const scan = scanClientConfig("desktop", file);
    expect(scan.state).toBe("invalid");
    expect((await checkLaunchConfig(makeIo(s), [scan])).details.join()).toMatch(
      /could not be read/,
    );
    writeFileSync(file, JSON.stringify({ mcpServers: [1, 2] }));
    expect(scanClientConfig("desktop", file)).toMatchObject({
      state: "ok",
      entries: [],
      others: 0,
    });
    rmSync(file);
    symlinkSync(path.join(s.dir), file);
    expect(scanClientConfig("desktop", file).state).toBe("invalid");
  });

  it("row 3: a secret value in a group-readable config fails; in a 0600 config warns; keys only, never values", () => {
    const s = fresh();
    const spec = {
      command: "/n",
      args: ["/a/dist/cli.js", "serve"],
      env: { YAHOO_CLIENT_SECRET: "xxxx-xxxx-xxxx", FF_LOG_LEVEL: "info", EMPTY_TOKEN: " " },
    };
    const readable = scanClientConfig("desktop", desktopConfig(s, { [SERVER_NAME]: spec }, 0o644));
    const r = checkClientSecrecy([readable]);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r)).not.toContain("xxxx-xxxx-xxxx");
    expect(r.details.join()).toContain("YAHOO_CLIENT_SECRET");
    expect(r.details.join()).not.toContain("EMPTY_TOKEN");
    const priv = scanClientConfig("desktop", desktopConfig(s, { [SERVER_NAME]: spec }, 0o600));
    expect(checkClientSecrecy([priv]).status).toBe("warn");
    expect(checkClientSecrecy([priv, readable]).status).toBe("fail");
  });

  it("row 13: FF_WRITE_ENABLED=1 warns; reach-session signals are reported without names", () => {
    const s = fresh();
    const file = desktopConfig(s, {
      [SERVER_NAME]: { command: "/n", args: ["/a/dist/cli.js", "serve"] },
      "secret-named-server": {},
    });
    const scans = [scanClientConfig("desktop", file)];
    const w = checkWriteFlag(cfg(s, { FF_WRITE_ENABLED: "1" }), {}, scans);
    expect(w.status).toBe("warn");
    const r = checkWriteFlag(cfg(s), { CLAUDECODE: "1" }, scans);
    expect(r.status).toBe("ok");
    expect(r.message).toContain("reach session detected");
    expect(r.details.join()).toContain("1 other MCP server");
    expect(JSON.stringify(r)).not.toContain("secret-named-server");
    expect(checkWriteFlag(null, {}, []).message).toMatch(/^writes are not supported/);
  });
});

describe("row 4 — config dir and league file", () => {
  it("missing dir fails with the --fix hint; 0755 fails; 0700 passes", () => {
    const s = fresh();
    expect(checkConfigDir(cfg(s)).status).toBe("fail");
    expect(checkConfigDir(cfg(s)).fix).toContain("--fix");
    mkdirSync(s.configDir, { mode: 0o755 });
    chmodSync(s.configDir, 0o755);
    expect(checkConfigDir(cfg(s)).message).toContain("group/other");
    chmodSync(s.configDir, 0o700);
    expect(checkConfigDir(cfg(s))).toMatchObject({ status: "ok", details: ["no league.yaml yet"] });
  });

  it("league.yaml: 0644 fails, a symlink fails, 0600 passes; the fixture league is exempt", () => {
    const s = fresh({ create: true });
    const league = path.join(s.configDir, "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o644);
    expect(checkConfigDir(cfg(s)).status).toBe("fail");
    chmodSync(league, 0o600);
    expect(checkConfigDir(cfg(s)).status).toBe("ok");
    rmSync(league);
    symlinkSync(FIXTURE_LEAGUE, league);
    expect(checkConfigDir(cfg(s)).message).toContain("symbolic link");
    expect(checkConfigDir(cfg(s, fixtureEnv())).details).toEqual([
      "fixture league (FF_FIXTURE_DIR): 0600 not required",
    ]);
  });

  it("league.yaml: the detail states the REAL mode; an owner-unreadable file fails with a chmod remedy [QA-1-056]", () => {
    const s = fresh({ create: true });
    const league = path.join(s.configDir, "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o400);
    expect(checkConfigDir(cfg(s))).toMatchObject({
      status: "ok",
      details: ["league.yaml is 0400"],
    });
    for (const m of [0o000, 0o200]) {
      chmodSync(league, m);
      const r = checkConfigDir(cfg(s));
      expect(r.status, m.toString(8)).toBe("fail");
      expect(r.message).toBe(
        `league.yaml is 0${m.toString(8).padStart(3, "0")} — you cannot read it`,
      );
      expect(r.fix).toContain("chmod 600");
      expect(JSON.stringify(r)).not.toContain("is 0600");
    }
    chmodSync(league, 0o600);
    expect(checkConfigDir(cfg(s)).details).toEqual(["league.yaml is 0600"]);
  });

  it("--fix --yes restores 0600 on an owner-unreadable league.yaml [QA-1-056]", async () => {
    const s = fresh({ create: true });
    mkdirSync(s.cacheDir, { recursive: true, mode: 0o700 });
    const league = path.join(s.configDir, "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o000);
    const io = makeIo(s);
    const r = await runDoctor(io, { json: true, online: false, fix: true, yes: true });
    expect(io.err.text).toContain(`fixed: chmod 600 ${league}`);
    expect(byId(r.rows, "config_dir").status).toBe("ok");
    expect(byId(r.rows, "league_file").status).toBe("ok");
  });

  it("an arbitrary FF_FIXTURE_DIR does not waive 0600 on a real league file [QA-1-094]", () => {
    const s = fresh({ create: true });
    const league = path.join(s.home, "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o644);
    for (const fx of ["/", s.home]) {
      const c = cfg(s, { FF_FIXTURE_DIR: fx, FF_LEAGUE_FILE: league });
      const r = checkConfigDir(c);
      expect(r.status, fx).toBe("fail");
      expect(r.message, fx).toContain("group/other-accessible");
      const lf = checkLeagueFile(makeIo(s), c, log(s));
      expect(lf.row.status, fx).toBe("fail");
    }
  });

  it("league file: missing → fail with the onboard hint; invalid → value-free issues; valid → ok, no names", () => {
    const s = fresh({ create: true });
    const io = makeIo(s);
    const missing = checkLeagueFile(io, cfg(s), log(s));
    expect(missing.row.status).toBe("fail");
    expect(missing.row.fix).toContain("onboard");
    const league = path.join(s.configDir, "league.yaml");
    writeFileSync(league, "version: 1\nleague:\n  name: Secret Team Name Here\n  season: nope\n", {
      mode: 0o600,
    });
    const bad = checkLeagueFile(io, cfg(s), log(s));
    expect(bad.row.status).toBe("fail");
    expect(bad.row.details.length).toBeGreaterThan(0);
    expect(JSON.stringify(bad.row)).not.toContain("Secret Team Name Here");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o600);
    const ok = checkLeagueFile(io, cfg(s), log(s));
    expect(ok.row).toMatchObject({
      status: "ok",
      message: "league.yaml is valid (season 2026, 12 teams)",
    });
    expect(ok.leagueKey).toBe("manual.l.example");
    expect(JSON.stringify(ok.row)).not.toContain("Example League");
  });
});

describe("rows 8–10 — store, datasets, journal", () => {
  it("row 8: cache missing → warn; 0755 → fail; store missing → warn", () => {
    const s = fresh();
    const c = cfg(s);
    const clock = fixedClock(REFRESHED_AT);
    expect(checkStore(c, openExistingStore(c, clock, log(s))).status).toBe("warn");
    mkdirSync(s.cacheDir, { mode: 0o755 });
    chmodSync(s.cacheDir, 0o755);
    expect(checkStore(c, { kind: "missing" }).status).toBe("fail");
    chmodSync(s.cacheDir, 0o700);
    expect(checkStore(c, openExistingStore(c, clock, log(s)))).toMatchObject({
      status: "warn",
      message: "store.sqlite not created yet",
    });
  });

  it("row 8: a healthy refreshed store passes quick_check; a corrupt or missing dataset file fails", () => {
    const s = refreshed();
    const c = cfg(s);
    const clock = fixedClock(REFRESHED_AT);
    const ex = openExistingStore(c, clock, log(s));
    try {
      expect(checkStore(c, ex).status).toBe("ok");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    writeFileSync(datasetFilePath(s.cacheDir, "nflverse:injuries"), "garbage ".repeat(1000));
    rmSync(datasetFilePath(s.cacheDir, "nflverse:roster_weekly"));
    const ex2 = openExistingStore(c, clock, log(s));
    try {
      const r = checkStore(c, ex2);
      expect(r.status).toBe("fail");
      expect(r.details.join("\n")).toMatch(
        /nflverse:injuries: dataset file quick_check (corrupt|unreadable)/,
      );
      // a plain refresh repairs it (QA-1-038): the fix never says --force
      expect(r.details.join("\n")).toContain("`ff refresh nflverse:injuries`");
      expect(r.details.join("\n")).not.toContain("--force");
      expect(r.details.join("\n")).toMatch(
        /nflverse:roster_weekly: listed as current but its dataset file is missing/,
      );
    } finally {
      if (ex2.kind === "open") ex2.store.close();
    }
    expect(quickCheckFile(path.join(s.dir, "nope.sqlite"))).toBe("unreadable");
  });

  it("row 8: a dataset file of another layout (ds_schema) fails and names the refresh [QA-1-098]", () => {
    const s = refreshed();
    const c = cfg(s);
    const clock = fixedClock(REFRESHED_AT);
    const db = new DatabaseSync(datasetFilePath(s.cacheDir, "nflverse:schedules"));
    db.exec(
      `UPDATE dataset_meta SET value = '${String(DS_SCHEMA_VERSION + 1)}' WHERE key = 'ds_schema'`,
    );
    db.close();
    const ex = openExistingStore(c, clock, log(s));
    try {
      const r = checkStore(c, ex);
      expect(r.status).toBe("fail");
      expect(r.details.join("\n")).toContain(
        `nflverse:schedules: dataset file layout v${String(DS_SCHEMA_VERSION + 1)}, this binary reads v${String(DS_SCHEMA_VERSION)} — \`ff refresh nflverse:schedules\``,
      );
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
  });

  it("row 8: newer / pending / error stores", () => {
    const s = refreshed();
    const c = cfg(s);
    expect(checkStore(c, { kind: "newer", storeVersion: 9, binaryVersion: 1 }).status).toBe("fail");
    expect(checkStore(c, { kind: "pending", storeVersion: 0, binaryVersion: 1 }).status).toBe(
      "warn",
    );
    expect(checkStore(c, { kind: "error", message: "x" }).status).toBe("fail");
    const db = new DatabaseSync(storePath(s.cacheDir));
    db.exec(
      "INSERT INTO schema_version (version, applied_at) VALUES (5, '2030-01-01T00:00:00.000Z')",
    );
    db.close();
    const ex = openExistingStore(c, fixedClock(REFRESHED_AT), log(s));
    expect(ex.kind).toBe("newer");
    expect(checkStore(c, ex).message).toContain("newer version (v5)");
  });

  it("row 9: fresh nflverse + never-loaded weather warns; ten days later fails; no store fails", () => {
    const s = refreshed();
    const c = cfg(s);
    const now = fixedClock("2026-09-30T18:10:00.000Z");
    const ex = openExistingStore(c, now, log(s));
    try {
      const r = checkDatasets(makeIo(s, { clock: now }), c, ex);
      expect(r.status).toBe("warn");
      expect(r.details).toContain("weather:open_meteo: never_loaded");
      const later = fixedClock("2026-10-10T19:00:00.000Z");
      expect(checkDatasets(makeIo(s, { clock: later }), c, ex).status).toBe("fail");
      const off = cfg(s, { FF_WEATHER_SOURCE: "off" });
      expect(checkDatasets(makeIo(s, { clock: now }), off, ex).status).toBe("ok");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    expect(checkDatasets(makeIo(s), c, { kind: "missing" }).status).toBe("fail");
  });

  it("row 8: an unwritable cache dir names the real problem; row 9 skips instead of 'never_loaded' [QA-1-053]", () => {
    const s = refreshed();
    const c = cfg(s);
    const clock = fixedClock("2026-09-30T18:10:00.000Z");
    chmodSync(s.cacheDir, 0o500);
    try {
      const ex = openExistingStore(c, clock, log(s));
      try {
        const r8 = checkStore(c, ex);
        expect(r8.status).toBe("fail");
        expect(r8.message).toContain("not writable");
        expect(r8.fix).toContain("chmod 700");
        expect(r8.fix).not.toMatch(/move it aside|refresh all/);
        const r9 = checkDatasets(makeIo(s, { clock }), c, ex);
        expect(r9).toMatchObject({ status: "skip", message: "store not open" });
        expect(JSON.stringify(r9)).not.toContain("never_loaded");
      } finally {
        if (ex.kind === "open") ex.store.close();
      }
    } finally {
      chmodSync(s.cacheDir, 0o700);
    }
  });

  it("row 8: a store that is not a database is named as such; a read-only store gets a chmod remedy [QA-1-053]", () => {
    const s = refreshed();
    const c = cfg(s);
    const clock = fixedClock(REFRESHED_AT);
    // every SQLite open failure maps to a fixed reason with its own remedy (never "move it aside"
    // for a permission problem)
    const sqliteError = (errcode: number): Error =>
      Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode });
    expect(storeOpenReason(sqliteError(1544))).toBe("readonly"); // SQLITE_READONLY_DIRECTORY
    expect(storeOpenReason(sqliteError(26))).toBe("not_a_database");
    expect(storeOpenReason(sqliteError(11))).toBe("corrupt");
    expect(storeOpenReason(sqliteError(5))).toBe("busy");
    expect(storeOpenReason(sqliteError(14))).toBe("cannot_open");
    expect(storeOpenReason(sqliteError(1))).toBe("other");
    expect(storeOpenReason(new TypeError("db.enableDefensive is not a function"))).toBe(
      "unsupported_node",
    );
    expect(storeOpenReason("x")).toBe("other");
    const ro = checkStore(c, { kind: "error", message: "Error: x", reason: "readonly" });
    expect(ro.fix).toContain("chmod 600");
    expect(ro.fix).not.toContain("move it aside");
    expect(checkStore(c, { kind: "error", message: "Error: odd" }).message).toBe(
      "store.sqlite could not be opened: Error: odd",
    );
    chmodSync(storePath(s.cacheDir), 0o600);
    writeFileSync(storePath(s.cacheDir), "GARBAGE".repeat(2000));
    const bad = openExistingStore(c, clock, log(s));
    expect(bad).toMatchObject({ kind: "error", reason: "not_a_database" });
    const r = checkStore(c, bad);
    expect(r.message).toContain("is not a SQLite database");
    expect(r.fix).toContain("restore a backup");
    expect(checkDatasets(makeIo(s, { clock }), c, bad).status).toBe("skip");
    // a newer or pending store is not open either: row 9 skips rather than claim never_loaded
    for (const ex of [
      { kind: "newer", storeVersion: 9, binaryVersion: 1 },
      { kind: "pending", storeVersion: 0, binaryVersion: 1 },
    ] as const)
      expect(checkDatasets(makeIo(s, { clock }), c, ex).status).toBe("skip");
  });

  it("--fix --yes restores 0700 (u+w) on our own unwritable cache dir [QA-1-053]", async () => {
    const s = refreshed();
    chmodSync(s.cacheDir, 0o500);
    try {
      const io = makeIo(s, { env: fixtureEnv(), clock: fixedClock("2026-09-30T18:10:00.000Z") });
      const r = await runDoctor(io, { json: true, online: false, fix: true, yes: true });
      expect(io.err.text).toContain(`fixed: chmod 700 ${s.cacheDir}`);
      expect(byId(r.rows, "store").status).toBe("ok");
      expect(byId(r.rows, "datasets").details.join("\n")).not.toMatch(
        /^nflverse:\w+: never_loaded/m,
      );
    } finally {
      chmodSync(s.cacheDir, 0o700);
    }
  });

  it("row 10: skip without a store; ok when empty; warn on a pending row", () => {
    const s = refreshed();
    const c = cfg(s);
    const io = makeIo(s, { clock: fixedClock(REFRESHED_AT) });
    expect(checkJournal(io, { kind: "missing" }).status).toBe("skip");
    let ex = openExistingStore(c, io.clock, log(s));
    try {
      expect(checkJournal(io, ex).status).toBe("ok");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    const db = new DatabaseSync(storePath(s.cacheDir));
    db.exec(
      "INSERT INTO write_journal VALUES ('j1', 'sent_unknown', '2026-09-30T17:00:00.000Z', 1790000000000, '2026-09-30T17:00:00.000Z', '{}')",
    );
    db.close();
    ex = openExistingStore(c, io.clock, log(s));
    try {
      expect(checkJournal(io, ex)).toMatchObject({ status: "warn" });
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
  });
});

describe("row 11 — launchd", () => {
  it("n/a off macOS; skip without a uid; warn when none installed", async () => {
    const s = fresh();
    expect((await checkLaunchd(makeIo(s, { platform: "linux" }), null)).status).toBe("na");
    expect((await checkLaunchd(makeIo(s, { platform: "darwin", uid: null }), null)).status).toBe(
      "skip",
    );
    expect((await checkLaunchd(makeIo(s, { platform: "darwin" }), null)).status).toBe("warn");
  });

  it("all installed and loaded → ok with last runs; one not loaded → warn; launchctl print only", async () => {
    const s = refreshed();
    mkdirSync(launchAgentsDir(s.home), { recursive: true });
    for (const j of JOBS) writeFileSync(plistPath(s.home, j), "x");
    const c = cfg(s);
    const store = openStore(c, fixedClock(REFRESHED_AT), log(s), { migrate: false });
    try {
      const fx = fakeExec();
      const r = await checkLaunchd(makeIo(s, { platform: "darwin", exec: fx.exec }), store);
      expect(r.status).toBe("ok");
      expect(fx.calls.every((x) => x.file === LAUNCHCTL && x.args[0] === "print")).toBe(true);
      expect(r.details.join("\n")).toMatch(
        /nflverse-daily: loaded; last run nflverse:injuries ok at/,
      );
      const fx2 = fakeExec((x) => ({ code: x.args[1]?.endsWith(".weather") === true ? 113 : 0 }));
      const r2 = await checkLaunchd(makeIo(s, { platform: "darwin", exec: fx2.exec }), store);
      expect(r2.status).toBe("warn");
      expect(r2.details.join("\n")).toContain("weather: NOT loaded");
      rmSync(plistPath(s.home, "store-backup"));
      const r3 = await checkLaunchd(makeIo(s, { platform: "darwin", exec: fx.exec }), null);
      expect(r3.details.join("\n")).toContain("not installed: store-backup");
    } finally {
      store.close();
    }
  });
});

describe("rows 12, 19, 20, 21, 22", () => {
  it("row 12: .npmrc ok / missing keys / not a checkout", () => {
    const s = fresh();
    expect(checkNpmrc(checkout(s)).status).toBe("ok");
    const s2 = path.join(s.dir, "other");
    mkdirSync(s2);
    expect(checkNpmrc(s2).status).toBe("na");
    const root = checkout(s, { npmrc: "save-exact=true\nignore-scripts=false\n" });
    expect(checkNpmrc(root)).toMatchObject({
      status: "warn",
      message: "missing: ignore-scripts=true",
    });
    expect(checkNpmrc(ROOT).status).toBe("ok");
  });

  it("row 21: dist missing warns; older than a source fails; newer passes; installed is n/a", () => {
    const s = fresh();
    const root = checkout(s, { built: false });
    expect(checkStaleBuild(root).status).toBe("warn");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "cli.js"), "");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(path.join(root, "dist", "cli.js"), old, old);
    expect(checkStaleBuild(root).status).toBe("fail");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(path.join(root, "dist", "cli.js"), future, future);
    expect(checkStaleBuild(root).status).toBe("ok");
    expect(checkStaleBuild(s.home).status).toBe("na");
    expect(newestSourceMtime(path.join(root, "nope"))).toBe(0);
    expect(newestSourceMtime(path.join(root, "src"), { left: 0 })).toBe(0);
  });

  it("rows 19/20: skip without store or league; flags raise warn/fail", async () => {
    const s = refreshed();
    const c = cfg(s);
    expect(checkSettingsFlags(null, "manual.l.example").map((r) => r.status)).toEqual([
      "skip",
      "skip",
    ]);
    const store = openStore(c, fixedClock(REFRESHED_AT), log(s), { migrate: false });
    try {
      expect(checkSettingsFlags(store, null).map((r) => r.status)).toEqual(["skip", "skip"]);
      expect(checkSettingsFlags(store, "manual.l.example").map((r) => r.status)).toEqual([
        "ok",
        "ok",
      ]);
      await store.repos.leagueSettings.raiseFlag({
        league_key: "manual.l.example",
        kind: "scoring_mismatch",
        detail: ["pass_yds"],
        raised_at: REFRESHED_AT,
        acknowledged: false,
      });
      await store.repos.leagueSettings.raiseFlag({
        league_key: "manual.l.example",
        kind: "settings_changed",
        detail: [],
        raised_at: REFRESHED_AT,
        acknowledged: false,
      });
      const [r19, r20] = checkSettingsFlags(store, "manual.l.example");
      expect(r19?.status).toBe("warn");
      expect(r19?.details).toEqual(["pass_yds"]);
      expect(r20?.status).toBe("warn");
      await store.repos.leagueSettings.raiseFlag({
        league_key: "manual.l.example",
        kind: "scoring_mismatch_league",
        detail: [],
        raised_at: REFRESHED_AT,
        acknowledged: false,
      });
      expect(checkSettingsFlags(store, "manual.l.example")[0]?.status).toBe("fail");
    } finally {
      store.close();
    }
  });

  it("row 22: no log → skip; error lines → warn, redacted and truncated; exits only → ok", () => {
    const s = fresh();
    const io = makeIo(s);
    const file = path.join(s.dir, "mcp.log");
    expect(checkClientLog(io, file).status).toBe("skip");
    writeFileSync(
      file,
      [
        "2026 info started",
        "2026 Error: spawn ENOENT access_token=xxxxxxxxxxxx x".padEnd(400, "z"),
        "2026 Server transport closed unexpectedly, exit code 1",
      ].join("\n"),
    );
    const r = checkClientLog(io, file);
    expect(r.status).toBe("warn");
    expect(r.details.join("\n")).not.toContain("xxxxxxxxxxxx");
    expect(r.details.join("\n")).toContain("access_token=[redacted]");
    expect(r.details.every((d) => d.length < 260)).toBe(true);
    writeFileSync(file, "x\nclient disconnected, exit 0\n");
    expect(checkClientLog(io, file)).toMatchObject({
      status: "ok",
      message: "the client log shows exits only",
    });
    writeFileSync(file, "all good\n");
    expect(checkClientLog(io, file).status).toBe("ok");
    rmSync(file);
    symlinkSync("/etc/hosts", file);
    expect(checkClientLog(io, file).status).toBe("skip");
    const big = path.join(s.dir, "big.log");
    writeFileSync(big, `${"filler line\n".repeat(20_000)}last Error line\n`);
    expect(tailLines(big)?.at(-1)).toBe("last Error line");
    expect(tailLines(big)).toHaveLength(50);
    expect(tailLines(s.dir)).toBeNull();
  });
});

describe("runDoctor / ff doctor", () => {
  it("fresh install: exit 1, stable JSON shape, Yahoo rows n/a, zero network calls", async () => {
    const s = fresh();
    let networkCalls = 0;
    const counting: FetchLike = () => {
      networkCalls++;
      throw new Error("network in an offline doctor");
    };
    const io = makeIo(s, { fetch: counting });
    expect(await main(["doctor", "--json"], io)).toBe(EXIT.ERROR);
    expect(networkCalls).toBe(0);
    const r = JSON.parse(io.out.text) as DoctorReport;
    expect(Object.keys(r).sort()).toEqual([
      "exit_code",
      "generated_at",
      "node",
      "online",
      "rows",
      "version",
    ]);
    expect(r.exit_code).toBe(1);
    for (const row of r.rows)
      expect(Object.keys(row).sort()).toEqual([
        "details",
        "fix",
        "id",
        "message",
        "n",
        "status",
        "title",
      ]);
    expect(r.rows.map((x) => x.id)).toEqual([
      "config",
      "node",
      "launch_config",
      "client_secrecy",
      "config_dir",
      "league_file",
      "token_file",
      "client_secret",
      "gate_key",
      "store",
      "datasets",
      "journal",
      "launchd",
      "npmrc",
      "write_flag",
      "clock_skew",
      "token_validity",
      "provisioning",
      "sources_online",
      "listener",
      "scoring_mismatch",
      "settings_changed",
      "stale_build",
      "client_log",
    ]);
    for (const id of [
      "token_file",
      "client_secret",
      "clock_skew",
      "token_validity",
      "provisioning",
      "listener",
    ])
      expect(byId(r.rows, id).message).toContain("no Yahoo access");
    expect(byId(r.rows, "sources_online").status).toBe("skip");
    expect(io.err.text).toBe("");
  });

  it("a configuration error is exit 2 and names the key", async () => {
    const s = fresh();
    const io = makeIo(s, { env: { FF_TOOLSET: "everything" } });
    expect(await main(["doctor"], io)).toBe(EXIT.USAGE);
    expect(io.out.text).toContain("FF_TOOLSET");
    expect(io.out.text).toContain("[CONF]");
  });

  it("a healthy fixture install passes every non-launchd row", async () => {
    const s = refreshed();
    // an installed package (no .git, no src/): rows 12/21 are n/a, independent of this checkout's
    // dist/; its fixture tree is this checkout's (the fixture waiver covers only the running
    // package's own <package>/fixtures — QA-1-094)
    const pkg = path.join(s.dir, "pkg");
    mkdirSync(pkg);
    symlinkSync(FIXTURES, path.join(pkg, "fixtures"));
    const io = makeIo(s, {
      env: {
        FF_FIXTURE_DIR: path.join(pkg, "fixtures"),
        FF_LEAGUE_FILE: path.join(pkg, "fixtures", "manual", "league.yaml"),
        FF_WEATHER_SOURCE: "off",
      },
      clock: fixedClock("2026-09-30T18:10:00.000Z"),
      packageRoot: pkg,
    });
    const r = await runDoctor(io, { json: true, online: false, fix: false, yes: false });
    const bad = r.rows.filter((x) => x.status === "fail" || x.status === "config");
    expect(bad).toEqual([]);
    expect(byId(r.rows, "league_file").status).toBe("ok");
    expect(byId(r.rows, "datasets").status).toBe("ok");
    expect(byId(r.rows, "scoring_mismatch").status).toBe("ok");
    expect(r.exit_code).toBe(0);
  });

  it("--online checks release reachability through the injected transport", async () => {
    const s = refreshed();
    const ok = await runDoctor(makeIo(s, { env: fixtureEnv() }), {
      json: true,
      online: true,
      fix: false,
      yes: false,
    });
    expect(byId(ok.rows, "sources_online").status).toBe("ok");
    const down: FetchLike = () => Promise.resolve(new Response(null, { status: 503 }));
    const bad = await runDoctor(makeIo(s, { fetch: down }), {
      json: true,
      online: true,
      fix: false,
      yes: false,
    });
    expect(byId(bad.rows, "sources_online").status).toBe("fail");
    const conf = await runDoctor(makeIo(s, { env: { FF_TOOLSET: "x" } }), {
      json: true,
      online: true,
      fix: false,
      yes: false,
    });
    expect(byId(conf.rows, "sources_online").status).toBe("skip");
    expect(fixtureFetch(FIXTURES)).toBeTypeOf("function");
  });

  it("--fix --yes creates the dirs 0700 and tightens league.yaml; without --yes nothing changes", async () => {
    const s = fresh();
    const io = makeIo(s);
    await runDoctor(io, { json: true, online: false, fix: true, yes: false });
    expect(io.err.text).toContain("not applied (add --yes)");
    expect(() => checkConfigDir(cfg(s))).not.toThrow();
    expect(checkConfigDir(cfg(s)).status).toBe("fail");
    const io2 = makeIo(s);
    const r = await runDoctor(io2, { json: true, online: false, fix: true, yes: true });
    expect(io2.err.text).toContain("fixed: create config dir");
    expect(byId(r.rows, "config_dir").status).toBe("ok");
    expect(byId(r.rows, "store").message).toBe("store.sqlite not created yet");
    const league = path.join(s.configDir, "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, league);
    chmodSync(league, 0o644);
    chmodSync(s.cacheDir, 0o750);
    const io3 = makeIo(s);
    await runDoctor(io3, { json: true, online: false, fix: true, yes: true });
    expect(io3.err.text).toContain("fixed: chmod 600");
    expect(io3.err.text).toContain("fixed: chmod 700");
    expect(checkConfigDir(cfg(s)).status).toBe("ok");
  });

  it("--fix on a terminal asks y/N and applies on 'y'", async () => {
    const s = fresh();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const io = makeIo(s, { stdin });
    setTimeout(() => {
      stdin.write("y\n");
    }, 20);
    await runDoctor(io, { json: true, online: false, fix: true, yes: false });
    expect(io.err.text).toContain("[y/N]");
    expect(io.err.text).toContain("fixed: create config dir");
  });

  it("renderDoctor and exitCodeFor", () => {
    const okRow: DoctorRow = {
      n: 1,
      id: "a",
      title: "A",
      status: "ok",
      message: "m",
      fix: null,
      details: [],
    };
    const rows: DoctorRow[] = [
      okRow,
      { n: 2, id: "b", title: "B", status: "fail", message: "m", fix: "do x", details: ["d"] },
    ];
    expect(exitCodeFor(rows)).toBe(1);
    expect(exitCodeFor([...rows, { ...okRow, status: "config" }])).toBe(2);
    expect(exitCodeFor([okRow])).toBe(0);
    const text = renderDoctor({
      version: "0",
      node: "24",
      generated_at: "t",
      online: true,
      exit_code: 1,
      rows,
    }).join("\n");
    expect(text).toContain("[FAIL]  2 B — m");
    expect(text).toContain("→ do x");
    expect(text).toContain("(online)");
    expect(text).toContain("exit 1: failures above");
  });
});
