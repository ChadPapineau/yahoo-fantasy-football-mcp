// launchd.test.ts — plan 06 §2 launchd design as amended by the schedule-driven refresh: one plist
// per job (the 15-minute `refresh-due` tick with RunAtLoad, weekly prune and backup), absolute
// ProgramArguments, non-secret EnvironmentVariables, logs under ~/Library/Logs, Background/
// LowPriorityIO; the earlier per-source jobs retired on install and removed on uninstall; launchctl
// only through the injected executor and never on --dry-run (tests never run launchctl).
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import {
  installedPlists,
  JOBS,
  LABEL_PREFIX,
  LAUNCHCTL,
  labelOf,
  launchAgentsDir,
  plistPath,
  removeJobs,
  renderPlist,
  RETIRED_JOB_NAMES,
  retireJobs,
  selectJobs,
  writePlist,
  xmlEscape,
  type LaunchdJob,
} from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { parseTargets } from "../../src/cli/refresh.js";
import { fakeExec, fakePackage, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const job = (name: string): LaunchdJob => {
  const j = JOBS.find((x) => x.name === name);
  if (j === undefined) throw new Error(name);
  return j;
};

/** Parses our plist subset into the few fields the tests assert. */
function parsePlist(xml: string): {
  label: string;
  args: string[];
  env: Record<string, string>;
  calendar: Record<string, number>[];
  flags: Record<string, string>;
} {
  const between = (s: string, a: string, b: string): string => {
    const i = s.indexOf(a);
    const j = s.indexOf(b, i + a.length);
    return s.slice(i + a.length, j);
  };
  const strings = (s: string): string[] =>
    [...s.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
      (m[1] ?? "")
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'"),
    );
  const args = strings(between(xml, "<key>ProgramArguments</key>", "</array>"));
  const envBlock = between(xml, "<key>EnvironmentVariables</key>", "</dict>");
  const keys = [...envBlock.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1] ?? "");
  const vals = strings(envBlock);
  const env = Object.fromEntries(keys.map((k, i) => [k, vals[i] ?? ""]));
  const cal = between(xml, "<key>StartCalendarInterval</key>", "</array>\n</dict>");
  const calendar = [...cal.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((m) =>
    Object.fromEntries(
      [...(m[1] ?? "").matchAll(/<key>(\w+)<\/key>\s*<integer>(\d+)<\/integer>/g)].map((x) => [
        x[1] ?? "",
        Number(x[2]),
      ]),
    ),
  );
  const flags: Record<string, string> = {};
  for (const k of [
    "ProcessType",
    "LowPriorityIO",
    "RunAtLoad",
    "StandardOutPath",
    "StandardErrorPath",
    "Label",
  ]) {
    const m = new RegExp(`<key>${k}</key>\\s*(<string>([^<]*)</string>|<(true|false)/>)`).exec(xml);
    flags[k] = m?.[2] ?? m?.[3] ?? "";
  }
  return { label: flags.Label ?? "", args, env, calendar, flags };
}

describe("the job table: one refresh tick + weekly prune and backup", () => {
  it("has refresh-due, store-prune and store-backup with unique names and valid calendar fields", () => {
    expect(JOBS.map((j) => j.name)).toEqual(["refresh-due", "store-prune", "store-backup"]);
    for (const j of JOBS) {
      expect(j.calendar.length).toBeGreaterThan(0);
      for (const c of j.calendar) {
        if (c.Minute !== undefined) expect(c.Minute >= 0 && c.Minute <= 59).toBe(true);
        if (c.Hour !== undefined) expect(c.Hour >= 0 && c.Hour <= 23).toBe(true);
        if (c.Weekday !== undefined) expect(c.Weekday >= 0 && c.Weekday <= 6).toBe(true);
      }
    }
  });

  it("refresh-due: minutes 0/15/30/45 of every hour, every day, RunAtLoad — no weekday or hour in any data refresh", () => {
    const tick = job("refresh-due");
    expect(tick.argv).toEqual(["refresh", "due", "--notify"]);
    expect(tick.calendar).toEqual([{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }]);
    expect(tick.runAtLoad).toBe(true);
    for (const j of JOBS.filter((x) => x.argv[0] === "refresh"))
      for (const c of j.calendar) {
        expect(c.Weekday, j.name).toBeUndefined();
        expect(c.Hour, j.name).toBeUndefined();
      }
  });

  it("prune Sun 03:00 and backup Sun 03:10, neither at load", () => {
    expect(job("store-prune").calendar).toEqual([{ Weekday: 0, Hour: 3, Minute: 0 }]);
    expect(job("store-backup").calendar).toEqual([{ Weekday: 0, Hour: 3, Minute: 10 }]);
    expect(job("store-prune").runAtLoad).toBe(false);
    expect(job("store-backup").runAtLoad).toBe(false);
  });

  it("the retired names are never reused by a current job", () => {
    expect(RETIRED_JOB_NAMES).toEqual([
      "nflverse-schedules",
      "nflverse-daily",
      "nflverse-stats",
      "weather",
    ]);
    for (const n of RETIRED_JOB_NAMES) expect(JOBS.map((j) => j.name)).not.toContain(n);
  });

  it("an upgraded binary under the earlier version's plists keeps working until install-launchd runs: their argv still parse", () => {
    // the retired jobs ran `ff refresh <target> --notify` with these targets
    const legacy: Record<string, string> = {
      "nflverse-schedules": "nflverse:schedules",
      "nflverse-daily": "nflverse:daily",
      "nflverse-stats": "nflverse:stats",
      weather: "weather",
    };
    expect(Object.keys(legacy)).toEqual([...RETIRED_JOB_NAMES]);
    for (const target of Object.values(legacy))
      expect(parseTargets([target]), target).toEqual([target]);
  });

  it("selectJobs: all by default, a subset by name; unknown names refused (bounded echo); a retired name names refresh-due", () => {
    expect(selectJobs(undefined)).toHaveLength(JOBS.length);
    expect(selectJobs("all")).toHaveLength(JOBS.length);
    expect(selectJobs("refresh-due, store-backup,refresh-due").map((j) => j.name)).toEqual([
      "refresh-due",
      "store-backup",
    ]);
    expect(() => selectJobs("store-prune,__proto__")).toThrow(/unknown job/);
    expect(() => selectJobs("x".repeat(1000))).toThrow(/unknown job\(s\): x{40}$/);
    for (const n of RETIRED_JOB_NAMES)
      expect(() => selectJobs(n), n).toThrow(/retired.*refresh-due/);
  });
});

describe("renderPlist", () => {
  const base = {
    node: "/opt/node/bin/node",
    entry: "/Users/me/pkg/dist/cli.js",
    home: "/Users/me",
  };

  it("absolute ProgramArguments, env, logs, flags and calendar", () => {
    const xml = renderPlist({
      ...base,
      job: job("refresh-due"),
      env: { FF_CACHE_DIR: "/c", FF_CONFIG_DIR: "/k" },
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    const p = parsePlist(xml);
    expect(p.label).toBe(`${LABEL_PREFIX}.refresh-due`);
    expect(p.args).toEqual([
      "/opt/node/bin/node",
      "/Users/me/pkg/dist/cli.js",
      "refresh",
      "due",
      "--notify",
    ]);
    expect(p.env).toEqual({ FF_CACHE_DIR: "/c", FF_CONFIG_DIR: "/k" });
    expect(p.flags.ProcessType).toBe("Background");
    expect(p.flags.LowPriorityIO).toBe("true");
    expect(p.flags.RunAtLoad).toBe("true");
    expect(p.flags.StandardOutPath).toBe(
      "/Users/me/Library/Logs/fantasy-football-mcp/refresh-due.log",
    );
    expect(p.calendar).toEqual([0, 15, 30, 45].map((m) => ({ Minute: m })));
    const prune = parsePlist(renderPlist({ ...base, job: job("store-prune"), env: {} }));
    expect(prune.flags.RunAtLoad).toBe("false");
    expect(prune.calendar).toEqual([{ Weekday: 0, Hour: 3, Minute: 0 }]);
  });

  it("escapes XML metacharacters in paths and env; refuses control characters and relative paths", () => {
    const xml = renderPlist({
      ...base,
      node: "/a&b/<node>",
      job: job("store-backup"),
      env: { FF_CACHE_DIR: `/x"'y` },
    });
    expect(xml).toContain("<string>/a&amp;b/&lt;node&gt;</string>");
    expect(parsePlist(xml).env.FF_CACHE_DIR).toBe(`/x"'y`);
    expect(() =>
      renderPlist({ ...base, job: job("store-backup"), env: { FF_CACHE_DIR: "/x\u0001" } }),
    ).toThrow(/control/);
    expect(() => renderPlist({ ...base, node: "node", job: job("store-backup"), env: {} })).toThrow(
      /absolute/,
    );
    expect(() =>
      renderPlist({ ...base, entry: "dist/cli.js", job: job("store-backup"), env: {} }),
    ).toThrow(/absolute/);
    expect(() => xmlEscape("a\u007fb")).toThrow();
    expect(xmlEscape("tab\tand\nnewline")).toBe("tab\tand\nnewline");
  });
});

describe("ff install-launchd", () => {
  it("--dry-run prints every plist with absolute paths and writes nothing, calls no launchctl", async () => {
    const s = sandbox();
    sb = s;
    const pkg = fakePackage(s);
    const fx = fakeExec();
    const io = makeIo(s, { packageRoot: pkg, platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd", "--dry-run"], io)).toBe(EXIT.OK);
    expect(fx.calls).toEqual([]);
    expect(() => lstatSync(launchAgentsDir(s.home))).toThrow();
    const out = io.out.text;
    for (const j of JOBS) expect(out).toContain(`# ${plistPath(sb.home, j)}`);
    expect(out).toContain(`<string>${process.execPath}</string>`);
    expect(out).toContain(`<string>${path.join(pkg, "dist", "cli.js")}</string>`);
    expect(out).toContain(
      `# would run: ${LAUNCHCTL} bootstrap gui/501 ${plistPath(sb.home, "refresh-due")}`,
    );
    expect(out).toContain(`<key>FF_CACHE_DIR</key>\n    <string>${sb.cacheDir}</string>`);
  });

  it("--dry-run works on linux and warns when dist/ is not built", async () => {
    sb = sandbox();
    const io = makeIo(sb, {
      packageRoot: fakePackage(sb, { built: false }),
      platform: "linux",
      uid: null,
    });
    expect(await main(["install-launchd", "--dry-run", "--jobs", "store-backup"], io)).toBe(
      EXIT.OK,
    );
    expect(io.err.text).toContain("npm run build");
    expect(io.out.text).toContain("gui/501");
  });

  it("FF_WEATHER_SOURCE=off changes no job (the tick skips weather); --jobs weather is a usage error naming refresh-due", async () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: fakePackage(sb), env: { FF_WEATHER_SOURCE: "off" } });
    expect(await main(["install-launchd", "--dry-run"], io)).toBe(EXIT.OK);
    for (const j of JOBS) expect(io.out.text).toContain(`${labelOf(j)}.plist`);
    for (const n of RETIRED_JOB_NAMES) {
      const io2 = makeIo(sb, { packageRoot: fakePackage(sb) });
      expect(await main(["install-launchd", "--jobs", n], io2), n).toBe(EXIT.USAGE);
      expect(io2.err.text).toMatch(/retired.*refresh-due/);
    }
  });

  it("installs: writes 0644 plists, boots out then bootstraps each, via the injected executor", async () => {
    sb = sandbox();
    const fx = fakeExec();
    const io = makeIo(sb, {
      packageRoot: fakePackage(sb),
      platform: "darwin",
      exec: fx.exec,
      uid: 777,
    });
    expect(await main(["install-launchd", "--jobs", "refresh-due,store-prune"], io)).toBe(EXIT.OK);
    const files = readdirSync(launchAgentsDir(sb.home)).sort();
    expect(files).toEqual([`${labelOf("refresh-due")}.plist`, `${labelOf("store-prune")}.plist`]);
    expect(lstatSync(plistPath(sb.home, "refresh-due")).mode & 0o777).toBe(0o644);
    expect(parsePlist(readFileSync(plistPath(sb.home, "refresh-due"), "utf8")).args[0]).toBe(
      process.execPath,
    );
    expect(fx.calls).toEqual([
      { file: LAUNCHCTL, args: ["bootout", `gui/777/${labelOf("refresh-due")}`] },
      { file: LAUNCHCTL, args: ["bootstrap", "gui/777", plistPath(sb.home, "refresh-due")] },
      { file: LAUNCHCTL, args: ["bootout", `gui/777/${labelOf("store-prune")}`] },
      { file: LAUNCHCTL, args: ["bootstrap", "gui/777", plistPath(sb.home, "store-prune")] },
    ]);
    expect(
      lstatSync(path.join(sb.home, "Library", "Logs", "fantasy-football-mcp")).isDirectory(),
    ).toBe(true);
    // re-running replaces in place
    expect(
      await main(
        ["install-launchd", "--jobs", "refresh-due"],
        makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec }),
      ),
    ).toBe(EXIT.OK);
  });

  it("a failed bootstrap exits 1 and says which", async () => {
    sb = sandbox();
    const fx = fakeExec((c) => ({ code: c.args[0] === "bootstrap" ? 5 : 3 }));
    const io = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd", "--jobs", "refresh-due"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toContain("launchctl exit 5");
  });

  it("refuses to run for real off macOS, without a uid, or unbuilt", async () => {
    sb = sandbox();
    expect(
      await main(
        ["install-launchd"],
        makeIo(sb, { packageRoot: fakePackage(sb), platform: "linux" }),
      ),
    ).toBe(EXIT.USAGE);
    expect(
      await main(
        ["install-launchd"],
        makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", uid: null }),
      ),
    ).toBe(EXIT.ERROR);
    const fx = fakeExec();
    expect(
      await main(
        ["install-launchd"],
        makeIo(sb, {
          packageRoot: fakePackage(sb, { built: false }),
          platform: "darwin",
          exec: fx.exec,
        }),
      ),
    ).toBe(EXIT.ERROR);
    expect(fx.calls).toEqual([]);
    expect(
      await main(
        ["install-launchd", "--jobs", "nope"],
        makeIo(sb, { packageRoot: fakePackage(sb) }),
      ),
    ).toBe(EXIT.USAGE);
  });

  it("never writes through a symlinked plist or a symlinked LaunchAgents dir", () => {
    const s = sandbox();
    sb = s;
    const agents = launchAgentsDir(s.home);
    mkdirSync(agents, { recursive: true });
    const target = path.join(s.dir, "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, plistPath(s.home, "refresh-due"));
    expect(() => {
      writePlist(plistPath(s.home, "refresh-due"), "<x/>");
    }).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("keep");
    const home2 = path.join(s.dir, "home2");
    mkdirSync(path.join(home2, "Library"), { recursive: true });
    symlinkSync(s.dir, launchAgentsDir(home2));
    expect(() => {
      writePlist(plistPath(home2, "refresh-due"), "<x/>");
    }).toThrow(/plain directory/);
  });
});

describe("removeJobs", () => {
  it("boots out and removes only our known plists, current and retired; --dry-run removes nothing", async () => {
    sb = sandbox();
    const agents = launchAgentsDir(sb.home);
    mkdirSync(agents, { recursive: true });
    writeFileSync(plistPath(sb.home, "refresh-due"), "x");
    writeFileSync(plistPath(sb.home, "weather"), "x");
    writeFileSync(path.join(agents, "com.other.agent.plist"), "x");
    writeFileSync(path.join(agents, `${LABEL_PREFIX}.unknown-job.plist`), "x");
    expect(installedPlists(sb.home)).toEqual([
      { job: "refresh-due", file: plistPath(sb.home, "refresh-due"), retired: false },
      { job: "weather", file: plistPath(sb.home, "weather"), retired: true },
    ]);
    const fx = fakeExec(() => ({ code: 113 }));
    const dry = await removeJobs({ home: sb.home, uid: 501, exec: fx.exec, dryRun: true });
    expect(dry.map((s) => s.kind)).toEqual(["launchctl", "remove", "launchctl", "remove"]);
    expect(fx.calls).toEqual([]);
    expect(installedPlists(sb.home)).toHaveLength(2);
    await removeJobs({ home: sb.home, uid: 501, exec: fx.exec, dryRun: false });
    expect(fx.calls).toEqual([
      { file: LAUNCHCTL, args: ["bootout", `gui/501/${labelOf("refresh-due")}`] },
      { file: LAUNCHCTL, args: ["bootout", `gui/501/${labelOf("weather")}`] },
    ]);
    expect(readdirSync(agents).sort()).toEqual([
      "com.other.agent.plist",
      `${LABEL_PREFIX}.unknown-job.plist`,
    ]);
  });

  it("installedPlists is empty when LaunchAgents does not exist", () => {
    sb = sandbox();
    expect(installedPlists(sb.home)).toEqual([]);
  });
});

describe("retiring the earlier version's jobs (an upgrade is one `ff install-launchd`)", () => {
  const legacyHome = (): Sandbox => {
    const s = sandbox();
    mkdirSync(launchAgentsDir(s.home), { recursive: true });
    for (const n of RETIRED_JOB_NAMES) writeFileSync(plistPath(s.home, n), "<legacy/>");
    return s;
  };

  it("install boots out and removes every legacy plist once refresh-due is loaded", async () => {
    sb = legacyHome();
    // "not loaded" from bootout is ignored
    const fx = fakeExec((c) => ({ code: c.args[0] === "bootout" ? 113 : 0 }));
    const io = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd"], io)).toBe(EXIT.OK);
    expect(installedPlists(sb.home).map((p) => p.job)).toEqual(JOBS.map((j) => j.name));
    for (const n of RETIRED_JOB_NAMES) {
      expect(io.out.text).toContain(`retired ${labelOf(n)}`);
      expect(fx.calls).toContainEqual({
        file: LAUNCHCTL,
        args: ["bootout", `gui/501/${labelOf(n)}`],
      });
    }
    // the legacy bootouts come after the new jobs are loaded
    const firstRetire = fx.calls.findIndex((c) => c.args[1]?.endsWith(".nflverse-schedules"));
    const lastBootstrap = fx.calls.map((c) => c.args[0]).lastIndexOf("bootstrap");
    expect(firstRetire).toBeGreaterThan(lastBootstrap);
  });

  it("--dry-run lists what would be retired and changes nothing", async () => {
    sb = legacyHome();
    const fx = fakeExec();
    const io = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd", "--dry-run"], io)).toBe(EXIT.OK);
    for (const n of RETIRED_JOB_NAMES) expect(io.out.text).toContain(`would retire ${labelOf(n)}`);
    expect(fx.calls).toEqual([]);
    expect(installedPlists(sb.home).filter((p) => p.retired)).toHaveLength(
      RETIRED_JOB_NAMES.length,
    );
  });

  it("keeps the legacy jobs when the new ones did not all load, or when refresh-due is not installed", async () => {
    sb = legacyHome();
    const failing = fakeExec((c) => ({ code: c.args[0] === "bootstrap" ? 5 : 0 }));
    const io = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: failing.exec });
    expect(await main(["install-launchd"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toContain("kept the earlier version's jobs");
    expect(installedPlists(sb.home).filter((p) => p.retired)).toHaveLength(
      RETIRED_JOB_NAMES.length,
    );
    const ok = fakeExec();
    const io2 = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: ok.exec });
    expect(await main(["install-launchd", "--jobs", "store-backup"], io2)).toBe(EXIT.OK);
    expect(installedPlists(sb.home).filter((p) => p.retired)).toHaveLength(
      RETIRED_JOB_NAMES.length,
    );
  });

  it("a symlinked legacy plist is refused (left in place, target untouched) and the install exits 1", async () => {
    const s = sandbox();
    sb = s;
    mkdirSync(launchAgentsDir(s.home), { recursive: true });
    const target = path.join(s.dir, "dotfiles-weather.plist");
    writeFileSync(target, "keep");
    symlinkSync(target, plistPath(s.home, "weather"));
    writeFileSync(plistPath(s.home, "nflverse-daily"), "<legacy/>");
    const fx = fakeExec();
    const dry = await retireJobs({ home: s.home, uid: 501, exec: fx.exec, dryRun: true });
    expect(dry.map((x) => [x.detail, x.ok])).toEqual([
      [labelOf("nflverse-daily"), true],
      [labelOf("weather"), false],
    ]);
    const io = makeIo(s, { packageRoot: fakePackage(s), platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toMatch(/FAIL retire .*weather: refusing to remove a symlink/);
    expect(lstatSync(plistPath(s.home, "weather")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(installedPlists(s.home).map((p) => p.job)).toEqual([
      ...JOBS.map((j) => j.name),
      "weather",
    ]);
  });
});
