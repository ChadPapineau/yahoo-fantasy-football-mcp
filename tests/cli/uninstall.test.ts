// uninstall.test.ts — plan 03 L8, §8: LaunchAgents booted out and removed; user data deleted only
// with --purge AND --yes, by exact name (a foreign file keeps its directory); client configs are
// printed, never edited.
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { LAUNCHCTL, labelOf, launchAgentsDir, plistPath } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { executePurge, purgePlan } from "../../src/cli/uninstall.js";
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
  mkdirSync(path.join(s.cacheDir, "tmp", "nflverse_injuries-AbC123"), { recursive: true });
  writeFileSync(path.join(s.cacheDir, "tmp", "nflverse_injuries-AbC123", "f"), "x");
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
    mkdirSync(path.join(s.dir, "d", "sub"), { recursive: true });
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
  });
});
