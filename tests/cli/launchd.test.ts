// launchd.test.ts — plan 06 §2 launchd design: one plist per job, absolute ProgramArguments,
// non-secret EnvironmentVariables, logs under ~/Library/Logs, Background/LowPriorityIO/RunAtLoad
// false, StartCalendarInterval entries matching §1.2; launchctl only through the injected executor
// and never on --dry-run (tests never run launchctl).
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
  selectJobs,
  writePlist,
  xmlEscape,
  type LaunchdJob,
} from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
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

describe("the job table (plan 06 §1.2, plan 10 §3.1a)", () => {
  it("has the six 1a jobs with unique names and valid calendar fields", () => {
    expect(JOBS.map((j) => j.name)).toEqual([
      "nflverse-schedules",
      "nflverse-daily",
      "nflverse-stats",
      "weather",
      "store-prune",
      "store-backup",
    ]);
    for (const j of JOBS) {
      expect(j.calendar.length).toBeGreaterThan(0);
      for (const c of j.calendar) {
        if (c.Minute !== undefined) expect(c.Minute >= 0 && c.Minute <= 59).toBe(true);
        if (c.Hour !== undefined) expect(c.Hour >= 0 && c.Hour <= 23).toBe(true);
        if (c.Weekday !== undefined) expect(c.Weekday >= 0 && c.Weekday <= 6).toBe(true);
      }
    }
  });

  it("schedules: every :00 and :30 on Thu/Sun/Mon, every 6 h on the other days", () => {
    const cal = job("nflverse-schedules").calendar;
    for (const d of [4, 0, 1]) {
      expect(cal).toContainEqual({ Weekday: d, Minute: 0 });
      expect(cal).toContainEqual({ Weekday: d, Minute: 30 });
    }
    for (const d of [2, 3, 5, 6])
      for (const h of [0, 6, 12, 18])
        expect(cal).toContainEqual({ Weekday: d, Hour: h, Minute: 0 });
    expect(cal).toHaveLength(6 + 16);
  });

  it("daily 10:30 plus 16:30 Wed–Sat; stats 04:30 + game-day runs; prune Sun 03:00; backup Sun 03:10", () => {
    expect(job("nflverse-daily").calendar).toEqual([
      { Hour: 10, Minute: 30 },
      ...[3, 4, 5, 6].map((d) => ({ Weekday: d, Hour: 16, Minute: 30 })),
    ]);
    expect(job("nflverse-stats").calendar).toContainEqual({ Hour: 4, Minute: 30 });
    expect(job("nflverse-stats").calendar).toContainEqual({ Weekday: 0, Hour: 21, Minute: 0 });
    expect(job("store-prune").calendar).toEqual([{ Weekday: 0, Hour: 3, Minute: 0 }]);
    expect(job("store-backup").calendar).toEqual([{ Weekday: 0, Hour: 3, Minute: 10 }]);
    expect(job("weather").calendar).toHaveLength(6);
    expect(job("weather").argv).toEqual(["refresh", "weather", "--notify"]);
  });

  it("selectJobs: all by default, a subset by name, unknown names refused (bounded echo)", () => {
    expect(selectJobs(undefined)).toHaveLength(JOBS.length);
    expect(selectJobs("all")).toHaveLength(JOBS.length);
    expect(selectJobs("weather, store-backup,weather").map((j) => j.name)).toEqual([
      "weather",
      "store-backup",
    ]);
    expect(() => selectJobs("weather,__proto__")).toThrow(/unknown job/);
    expect(() => selectJobs("x".repeat(1000))).toThrow(/unknown job\(s\): x{40}$/);
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
      job: job("nflverse-daily"),
      env: { FF_CACHE_DIR: "/c", FF_CONFIG_DIR: "/k" },
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    const p = parsePlist(xml);
    expect(p.label).toBe(`${LABEL_PREFIX}.nflverse-daily`);
    expect(p.args).toEqual([
      "/opt/node/bin/node",
      "/Users/me/pkg/dist/cli.js",
      "refresh",
      "nflverse:daily",
      "--notify",
    ]);
    expect(p.env).toEqual({ FF_CACHE_DIR: "/c", FF_CONFIG_DIR: "/k" });
    expect(p.flags.ProcessType).toBe("Background");
    expect(p.flags.LowPriorityIO).toBe("true");
    expect(p.flags.RunAtLoad).toBe("false");
    expect(p.flags.StandardOutPath).toBe(
      "/Users/me/Library/Logs/fantasy-football-mcp/nflverse-daily.log",
    );
    expect(p.calendar).toEqual([
      { Hour: 10, Minute: 30 },
      ...[3, 4, 5, 6].map((d) => ({ Weekday: d, Hour: 16, Minute: 30 })),
    ]);
  });

  it("escapes XML metacharacters in paths and env; refuses control characters and relative paths", () => {
    const xml = renderPlist({
      ...base,
      node: "/a&b/<node>",
      job: job("weather"),
      env: { FF_CACHE_DIR: `/x"'y` },
    });
    expect(xml).toContain("<string>/a&amp;b/&lt;node&gt;</string>");
    expect(parsePlist(xml).env.FF_CACHE_DIR).toBe(`/x"'y`);
    expect(() =>
      renderPlist({ ...base, job: job("weather"), env: { FF_CACHE_DIR: "/x\u0001" } }),
    ).toThrow(/control/);
    expect(() => renderPlist({ ...base, node: "node", job: job("weather"), env: {} })).toThrow(
      /absolute/,
    );
    expect(() =>
      renderPlist({ ...base, entry: "dist/cli.js", job: job("weather"), env: {} }),
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
      `# would run: ${LAUNCHCTL} bootstrap gui/501 ${plistPath(sb.home, "weather")}`,
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

  it("drops the weather job when FF_WEATHER_SOURCE=off (unless asked for)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: fakePackage(sb), env: { FF_WEATHER_SOURCE: "off" } });
    expect(await main(["install-launchd", "--dry-run"], io)).toBe(EXIT.OK);
    expect(io.out.text).not.toContain("ff.weather.plist");
    const io2 = makeIo(sb, { packageRoot: fakePackage(sb), env: { FF_WEATHER_SOURCE: "off" } });
    expect(await main(["install-launchd", "--dry-run", "--jobs", "weather"], io2)).toBe(EXIT.OK);
    expect(io2.out.text).toContain("ff.weather.plist");
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
    expect(await main(["install-launchd", "--jobs", "weather,store-prune"], io)).toBe(EXIT.OK);
    const files = readdirSync(launchAgentsDir(sb.home)).sort();
    expect(files).toEqual([`${labelOf("store-prune")}.plist`, `${labelOf("weather")}.plist`]);
    expect(lstatSync(plistPath(sb.home, "weather")).mode & 0o777).toBe(0o644);
    expect(parsePlist(readFileSync(plistPath(sb.home, "weather"), "utf8")).args[0]).toBe(
      process.execPath,
    );
    expect(fx.calls).toEqual([
      { file: LAUNCHCTL, args: ["bootout", `gui/777/${labelOf("weather")}`] },
      { file: LAUNCHCTL, args: ["bootstrap", "gui/777", plistPath(sb.home, "weather")] },
      { file: LAUNCHCTL, args: ["bootout", `gui/777/${labelOf("store-prune")}`] },
      { file: LAUNCHCTL, args: ["bootstrap", "gui/777", plistPath(sb.home, "store-prune")] },
    ]);
    expect(
      lstatSync(path.join(sb.home, "Library", "Logs", "fantasy-football-mcp")).isDirectory(),
    ).toBe(true);
    // re-running replaces in place
    expect(
      await main(
        ["install-launchd", "--jobs", "weather"],
        makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec }),
      ),
    ).toBe(EXIT.OK);
  });

  it("a failed bootstrap exits 1 and says which", async () => {
    sb = sandbox();
    const fx = fakeExec((c) => ({ code: c.args[0] === "bootstrap" ? 5 : 3 }));
    const io = makeIo(sb, { packageRoot: fakePackage(sb), platform: "darwin", exec: fx.exec });
    expect(await main(["install-launchd", "--jobs", "weather"], io)).toBe(EXIT.ERROR);
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
    symlinkSync(target, plistPath(s.home, "weather"));
    expect(() => {
      writePlist(plistPath(s.home, "weather"), "<x/>");
    }).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("keep");
    const home2 = path.join(s.dir, "home2");
    mkdirSync(path.join(home2, "Library"), { recursive: true });
    symlinkSync(s.dir, launchAgentsDir(home2));
    expect(() => {
      writePlist(plistPath(home2, "weather"), "<x/>");
    }).toThrow(/plain directory/);
  });
});

describe("removeJobs", () => {
  it("boots out and removes only our known plists; --dry-run removes nothing", async () => {
    sb = sandbox();
    const agents = launchAgentsDir(sb.home);
    mkdirSync(agents, { recursive: true });
    writeFileSync(plistPath(sb.home, "weather"), "x");
    writeFileSync(path.join(agents, "com.other.agent.plist"), "x");
    writeFileSync(path.join(agents, `${LABEL_PREFIX}.unknown-job.plist`), "x");
    expect(installedPlists(sb.home).map((p) => p.job)).toEqual(["weather"]);
    const fx = fakeExec(() => ({ code: 113 }));
    const dry = await removeJobs({ home: sb.home, uid: 501, exec: fx.exec, dryRun: true });
    expect(dry.map((s) => s.kind)).toEqual(["launchctl", "remove"]);
    expect(fx.calls).toEqual([]);
    expect(installedPlists(sb.home)).toHaveLength(1);
    await removeJobs({ home: sb.home, uid: 501, exec: fx.exec, dryRun: false });
    expect(fx.calls).toEqual([
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
