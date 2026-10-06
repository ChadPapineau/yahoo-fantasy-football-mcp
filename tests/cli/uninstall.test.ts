// uninstall.test.ts — plan 03 L8, §8: LaunchAgents booted out and removed; user data deleted only
// with --purge AND --yes, by exact name (a foreign file keeps its directory); client configs are
// printed, never edited.
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { LAUNCHCTL, labelOf, launchAgentsDir, plistPath } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { executePurge, purgePlan } from "../../src/cli/uninstall.js";
import { runTempDir } from "../../src/config/paths.js";
import { fsTempArea } from "../../src/sources/runner.js";
import { fakeExec, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

async function populated(): Promise<Sandbox> {
  const s = sandbox({ create: true });
  sb = s;
  expect(await main(["backup"], makeIo(s))).toBe(EXIT.OK);
  mkdirSync(path.join(s.cacheDir, "ds"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(s.cacheDir, "ds", "nflverse__injuries.sqlite"), "x");
  // a run directory exactly as `ff refresh` leaves one behind (0700 tmp/, mkdtemp 0700 entry)
  const run = await fsTempArea(runTempDir(s.cacheDir)).create("nflverse:injuries");
  writeFileSync(path.join(run, "f"), "x");
  writeFileSync(path.join(s.configDir, "league.yaml"), "x", { mode: 0o600 });
  mkdirSync(launchAgentsDir(s.home), { recursive: true });
  writeFileSync(plistPath(s.home, "weather"), "x");
  return s;
}

describe("ff uninstall", () => {
  it("without --purge: boots out and removes our plists, keeps every byte of data, prints manual steps", async () => {
    const s = await populated();
    const fx = fakeExec();
    const io = makeIo(s, { platform: "darwin", exec: fx.exec, uid: 502 });
    expect(await main(["uninstall"], io)).toBe(EXIT.OK);
    expect(fx.calls).toEqual([
      { file: LAUNCHCTL, args: ["bootout", `gui/502/${labelOf("weather")}`] },
    ]);
    expect(existsSync(plistPath(s.home, "weather"))).toBe(false);
    expect(existsSync(path.join(s.cacheDir, "store.sqlite"))).toBe(true);
    expect(existsSync(path.join(s.configDir, "league.yaml"))).toBe(true);
    expect(io.out.text).toContain("kept your data");
    expect(io.out.text).toContain("claude mcp remove --scope user fantasy-football-mcp-server");
    expect(io.out.text).toContain("claude_desktop_config.json");
  });

  it("--purge without --yes changes nothing (not even launchd) and exits 2 listing what it would delete", async () => {
    const s = await populated();
    const fx = fakeExec();
    const io = makeIo(s, { platform: "darwin", exec: fx.exec });
    expect(await main(["uninstall", "--purge"], io)).toBe(EXIT.USAGE);
    expect(fx.calls).toEqual([]);
    expect(existsSync(plistPath(s.home, "weather"))).toBe(true);
    expect(existsSync(path.join(s.cacheDir, "store.sqlite"))).toBe(true);
    expect(io.err.text).toContain(path.join(s.cacheDir, "store.sqlite"));
    expect(io.err.text).toContain("ff backup --to");
  });

  it("--dry-run --purge --purge-config prints and deletes nothing", async () => {
    const s = await populated();
    const fx = fakeExec();
    const io = makeIo(s, { platform: "darwin", exec: fx.exec });
    expect(await main(["uninstall", "--dry-run", "--purge", "--purge-config"], io)).toBe(EXIT.OK);
    expect(fx.calls).toEqual([]);
    expect(io.out.text).toContain(`would delete ${path.join(s.configDir, "league.yaml")}`);
    expect(io.out.text).toContain(`would remove ${plistPath(s.home, "weather")}`);
    expect(existsSync(path.join(s.configDir, "league.yaml"))).toBe(true);
    expect(existsSync(plistPath(s.home, "weather"))).toBe(true);
  });

  it("--purge --yes deletes our cache files; a foreign file keeps its directory; config kept", async () => {
    const s = await populated();
    writeFileSync(path.join(s.cacheDir, "my-own-notes.txt"), "mine");
    const io = makeIo(s, { platform: "linux" });
    expect(await main(["uninstall", "--purge", "--yes"], io)).toBe(EXIT.OK);
    expect(readdirSync(s.cacheDir)).toEqual(["my-own-notes.txt"]);
    expect(io.out.text).toContain(`kept (not empty or not removable) ${s.cacheDir}`);
    expect(existsSync(path.join(s.configDir, "league.yaml"))).toBe(true);
    expect(io.out.text).toContain("launchd: not available on this platform");
  });

  it("--purge --purge-config --yes removes both directories entirely when only our files are in them", async () => {
    const s = await populated();
    const io = makeIo(s, { platform: "darwin", exec: fakeExec().exec });
    expect(await main(["uninstall", "--purge", "--purge-config", "--yes"], io)).toBe(EXIT.OK);
    expect(existsSync(s.cacheDir)).toBe(false);
    expect(existsSync(s.configDir)).toBe(false);
  });

  it("--purge-config alone is a usage error", async () => {
    const s = sandbox();
    sb = s;
    expect(await main(["uninstall", "--purge-config", "--yes"], makeIo(s))).toBe(EXIT.USAGE);
  });

  it("no plists installed: says so; a symlinked ds/ is never descended", async () => {
    const s = sandbox({ create: true });
    sb = s;
    const outside = path.join(s.dir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "nflverse__injuries.sqlite"), "keep");
    symlinkSync(outside, path.join(s.cacheDir, "ds"));
    const io = makeIo(s, { platform: "darwin", exec: fakeExec().exec });
    expect(await main(["uninstall", "--purge", "--yes"], io)).toBe(EXIT.OK);
    expect(io.out.text).toContain("no launchd jobs of ours are installed");
    expect(existsSync(path.join(outside, "nflverse__injuries.sqlite"))).toBe(true);
  });
});

describe("purge plan", () => {
  it("lists only existing, exactly named entries, and a missing dir yields nothing", () => {
    const s = sandbox();
    sb = s;
    expect(purgePlan(path.join(s.dir, "none"), ["a"], [])).toEqual([]);
    mkdirSync(path.join(s.dir, "d", "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(s.dir, "d", "sub", "ok.x"), "");
    writeFileSync(path.join(s.dir, "d", "sub", "nope.y"), "");
    writeFileSync(path.join(s.dir, "d", "f"), "");
    const plan = purgePlan(path.join(s.dir, "d"), ["f", "missing"], [{ name: "sub", re: /\.x$/ }]);
    expect(plan.map((p) => [path.relative(s.dir, p.path), p.action])).toEqual([
      ["d/sub/ok.x", "unlink"],
      ["d/sub", "rmdir"],
      ["d/f", "unlink"],
      ["d", "rmdir"],
    ]);
    const r = executePurge(plan);
    expect(r.kept.map((p) => path.relative(s.dir, p))).toEqual(["d/sub", "d"]);
    expect(existsSync(path.join(s.dir, "d", "sub", "nope.y"))).toBe(true);
    // a pattern directory that is not our private one is kept whole, with the reason (QA-2-029)
    chmodSync(path.join(s.dir, "d", "sub"), 0o755);
    const loose = purgePlan(path.join(s.dir, "d"), [], [{ name: "sub", re: /\.y$/ }]);
    expect(loose[0]).toMatchObject({ path: path.join(s.dir, "d", "sub"), action: "keep" });
    expect(executePurge(loose).removed).toEqual([]);
    expect(existsSync(path.join(s.dir, "d", "sub", "nope.y"))).toBe(true);
  });
});

describe("purge never deletes a directory tree it did not create (QA-2-029)", () => {
  /** FF_CACHE_DIR on a shared directory that already holds a `tmp/` with a person's own folder. */
  async function sharedCache(tmpMode: number, entryMode: number) {
    const s = sandbox({ create: true });
    sb = s;
    const shared = path.join(s.dir, "shared");
    mkdirSync(shared, { mode: 0o700 });
    const tmp = path.join(shared, "tmp");
    mkdirSync(tmp);
    chmodSync(tmp, tmpMode);
    // ordinary names that happen to fit the run-temp grammar (`<word>-<6 chars>`)
    const docs = ["client-report", "notes-backup"].map((n) => {
      const d = path.join(tmp, n);
      mkdirSync(d);
      writeFileSync(path.join(d, "q3-numbers.txt"), "user document\n");
      chmodSync(d, entryMode);
      return path.join(d, "q3-numbers.txt");
    });
    const io = makeIo(s, { env: { FF_CACHE_DIR: shared } });
    const rc = await main(["uninstall", "--purge", "--yes"], io);
    return { rc, io, docs, tmp };
  }

  // every layout except the program's own (0700 tmp/ holding a 0700 directory of ours)
  const layouts: [number, number][] = [
    [0o755, 0o755],
    [0o755, 0o700],
    [0o750, 0o700],
    [0o705, 0o700],
    [0o770, 0o700],
    [0o700, 0o755],
    [0o700, 0o750],
    [0o700, 0o705],
    [0o700, 0o711],
  ];
  for (const [tmpMode, entryMode] of layouts) {
    it(`tmp/ ${tmpMode.toString(8)}, entry ${entryMode.toString(8)}: the person's files survive`, async () => {
      const r = await sharedCache(tmpMode, entryMode);
      expect(r.rc).toBe(EXIT.OK);
      for (const d of r.docs) expect(existsSync(d)).toBe(true);
      expect(r.io.out.text).not.toMatch(/^deleted .*client-report/m);
      // the person is told what was left and why, not only that a directory was not empty
      expect(r.io.out.text).toMatch(/^kept \(not ours/m);
    });
  }

  it("--purge without --yes lists the person's directories as kept, not as deletions", async () => {
    const s = sandbox({ create: true });
    sb = s;
    const tmp = runTempDir(s.cacheDir);
    mkdirSync(tmp, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    mkdirSync(path.join(tmp, "client-report"));
    const io = makeIo(s);
    expect(await main(["uninstall", "--purge"], io)).toBe(EXIT.USAGE);
    const [del, keep] = io.err.text.split(/It would leave alone/);
    expect(del).not.toContain("client-report");
    expect(keep).toContain(tmp);
  });

  it("--dry-run says it would keep the person's directories, and deletes nothing", async () => {
    const s = sandbox({ create: true });
    sb = s;
    const tmp = runTempDir(s.cacheDir);
    mkdirSync(tmp, { mode: 0o700 });
    mkdirSync(path.join(tmp, "client-report"), { mode: 0o755 });
    chmodSync(path.join(tmp, "client-report"), 0o755);
    const io = makeIo(s);
    expect(await main(["uninstall", "--dry-run", "--purge"], io)).toBe(EXIT.OK);
    expect(io.out.text).toContain(
      `would keep (not ours: not a run directory this program made) ${path.join(tmp, "client-report")}`,
    );
    expect(io.out.text).not.toMatch(/^kept \(not ours/m);
    expect(io.out.text).toContain(`would delete ${tmp} (if empty)`);
    expect(existsSync(path.join(tmp, "client-report"))).toBe(true);
  });

  it("positive control: the run directories `ff refresh` leaves are still deleted", async () => {
    const s = sandbox({ create: true });
    sb = s;
    const area = fsTempArea(runTempDir(s.cacheDir));
    const runs = [
      await area.create("nflverse:injuries"),
      await area.create("nflverse:stats_player_week"),
      await area.create("weather:open_meteo"),
    ];
    for (const r of runs) writeFileSync(path.join(r, "part"), "x");
    const io = makeIo(s);
    expect(await main(["uninstall", "--purge", "--yes"], io)).toBe(EXIT.OK);
    for (const r of runs) expect(existsSync(r)).toBe(false);
    expect(existsSync(s.cacheDir)).toBe(false);
  });

  it("a run-temp-shaped symlink or file in tmp/ is never followed or removed", async () => {
    const s = sandbox({ create: true });
    sb = s;
    const tmp = runTempDir(s.cacheDir);
    mkdirSync(tmp, { mode: 0o700 });
    const outside = path.join(s.dir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    symlinkSync(outside, path.join(tmp, "linked-AbC123"));
    writeFileSync(path.join(tmp, "notes-backup"), "a person's file");
    const io = makeIo(s);
    expect(await main(["uninstall", "--purge", "--yes"], io)).toBe(EXIT.OK);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(tmp, "notes-backup"))).toBe(true);
  });
});
