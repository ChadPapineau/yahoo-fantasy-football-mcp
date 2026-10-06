// onboard-yaml.test.ts — the onboard Skill's league-file guide (plan 09 §3.1 manual mode, plan 10
// §3.1a) must show YAML the server actually accepts: its example is parsed with the provider's own
// hardened parser and validated against its schema, so a schema change that the Skill does not
// follow fails here instead of in the user's terminal.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PathSecurityError,
  defaultLeagueFilePath,
  resolveConfigDir,
} from "../../src/config/paths.js";
import { leagueFileSchema, parseLeagueYaml } from "../../src/providers/manual/index.js";
import { FIXTURE_LEAGUE } from "../mcp/helpers/env.js";
import { ROOT, SHELLS, runSaveSteps, saveBlocks } from "./helpers.js";

const guide = readFileSync(
  path.join(ROOT, "skills/onboard/references/onboard-league-yaml.md"),
  "utf8",
);
const blocks = [...guide.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");

describe("the onboard guide's league.yaml", () => {
  it("has exactly one YAML example", () => {
    expect(blocks).toHaveLength(1);
  });

  it("parses with the provider's parser and passes the provider's schema", () => {
    const parsed = leagueFileSchema.safeParse(parseLeagueYaml(blocks[0] ?? ""));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it("uses placeholder identifiers only", () => {
    const yaml = blocks[0] ?? "";
    expect(yaml).toContain("name: Example League");
    expect(yaml).toContain("key: example");
    for (const m of yaml.matchAll(/^\s+name: (.+)$/gm)) {
      expect(m[1]).toMatch(/^Team [A-L]$|^Example League$/);
    }
  });
});

describe("QA-1-072: the guide's save commands put league.yaml where the server reads it", () => {
  it("has exactly one block of save commands, with umask 077", () => {
    expect(saveBlocks).toHaveLength(1);
    expect(saveBlocks[0]).toMatch(/^umask 077$/m);
  });

  const cases: readonly (readonly [string, (h: string) => Record<string, string>])[] = [
    ["no variables (~/.config)", () => ({})],
    ["XDG_CONFIG_HOME set", (h) => ({ XDG_CONFIG_HOME: path.join(h, "xdg") })],
    [
      "XDG_CONFIG_HOME relative (ignored, as the XDG spec says)",
      () => ({ XDG_CONFIG_HOME: "rel/xdg" }),
    ],
    ["FF_CONFIG_DIR set", (h) => ({ FF_CONFIG_DIR: path.join(h, "private", "ff") })],
    [
      "FF_CONFIG_DIR and XDG_CONFIG_HOME set",
      (h) => ({
        FF_CONFIG_DIR: path.join(h, "private", "ff"),
        XDG_CONFIG_HOME: path.join(h, "xdg"),
      }),
    ],
  ];
  for (const [label, envOf] of cases) {
    it(`${label}: the file lands at the server's league path, 0600 in a 0700 directory`, () => {
      const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-save-")));
      try {
        const home = path.join(base, "home");
        mkdirSync(home, { mode: 0o700 });
        const env = envOf(home);
        const { status, stderr, ffLog } = runSaveSteps(env, home);
        expect(status, stderr).toBe(0);
        const want = defaultLeagueFilePath(resolveConfigDir(env, home));
        expect(existsSync(want), `expected the league file at ${want}`).toBe(true);
        expect(statSync(want).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(want)).mode & 0o777).toBe(0o700);
        expect(readFileSync(want, "utf8")).toBe(readFileSync(FIXTURE_LEAGUE, "utf8"));
        expect(ffLog).toContain("ff doctor");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});

/** Every league.yaml under `dir` (the test's own temporary tree). */
function leagueFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => path.basename(f) === "league.yaml")
    .map((f) => path.join(dir, f));
}

/**
 * A value as a user may set it: a head (absolute, `~`, `~/…`, relative, `~name/…`), path segments
 * (with spaces, `.` and `..` that never climb out of the test's temporary tree), an optional
 * trailing slash, and ASCII whitespace around it (a quoted export, a client JSON config).
 */
type Head = "abs" | "home" | "tilde" | "rel" | "user";
const SEGMENTS = fc
  .array(fc.constantFrom("a", "b c", "ff", "x.y", ".", ".."), { maxLength: 4 })
  .filter((segs) => {
    let depth = 1; // under base/abs or base/home: one ".." reaches base, never above it
    for (const s of segs) {
      depth += s === ".." ? -1 : s === "." ? 0 : 1;
      if (depth < 0) return false;
    }
    return true;
  });
const PAD = fc.constantFrom("", " ", "\t", "  ", " \t", "\n", " \n");
const pathValue = (base: string) =>
  fc
    .record({
      head: fc.constantFrom<Head>("abs", "home", "tilde", "rel", "user"),
      segs: SEGMENTS,
      slash: fc.boolean(),
      left: PAD,
      right: PAD,
    })
    .map(({ head, segs, slash, left, right }) => {
      const tail = segs.length === 0 ? "" : `/${segs.join("/")}`;
      const core =
        head === "abs"
          ? `${base}/abs${tail}`
          : head === "home"
            ? "~"
            : head === "tilde"
              ? `~${tail === "" ? "/" : tail}`
              : head === "rel"
                ? `rel${tail}`
                : `~nobody${tail}`;
      return `${left}${core}${slash && head !== "home" ? "/" : ""}${right}`;
    });

describe("QA-1-072 (reopened): the save commands resolve every FF_CONFIG_DIR and XDG_CONFIG_HOME as the server does", () => {
  /** The server's league path for `env`, or null when it refuses FF_CONFIG_DIR. */
  const serverLeague = (env: Record<string, string>, home: string): string | null => {
    try {
      return defaultLeagueFilePath(resolveConfigDir(env, home));
    } catch (e) {
      if (e instanceof PathSecurityError) return null;
      throw e;
    }
  };

  for (const shell of SHELLS) {
    it(`${shell}: the file lands where the server reads it, or a STOP line leaves nothing behind`, () => {
      const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-save-")));
      let run = 0;
      try {
        fc.assert(
          fc.property(
            fc.option(pathValue(path.join(base, "r")), { nil: undefined }),
            fc.option(pathValue(path.join(base, "r")), { nil: undefined }),
            (ffConfigDir, xdg) => {
              // every run in its own tree: base/r<run>/{home,abs,cwd}
              const r = path.join(base, `r${String((run += 1))}`);
              const home = path.join(r, "home");
              const cwd = path.join(r, "cwd");
              mkdirSync(home, { recursive: true, mode: 0o700 });
              mkdirSync(cwd, { mode: 0o700 });
              const fix = (v: string) => v.replaceAll(path.join(base, "r"), r);
              const env: Record<string, string> = {};
              if (ffConfigDir !== undefined) env.FF_CONFIG_DIR = fix(ffConfigDir);
              if (xdg !== undefined) env.XDG_CONFIG_HOME = fix(xdg);
              const want = serverLeague(env, home);
              const out = runSaveSteps(env, home, { using: shell, cwd });
              const said = /^League file: (.*)$/m.exec(out.stdout)?.[1];
              // nothing is ever created relative to the folder the commands run from
              expect(readdirSync(cwd), JSON.stringify(env)).toEqual([]);
              if (want === null) {
                expect(out.stdout, JSON.stringify(env)).toMatch(/^STOP: FF_CONFIG_DIR /m);
                expect(said, JSON.stringify(env)).toBeUndefined();
                expect(leagueFilesUnder(r), JSON.stringify(env)).toEqual([]);
              } else {
                expect(out.stdout, JSON.stringify(env)).not.toMatch(/^STOP: FF_CONFIG_DIR /m);
                expect(existsSync(want), `${JSON.stringify(env)}: expected ${want}`).toBe(true);
                expect(said, JSON.stringify(env)).toBeDefined();
                expect(realpathSync(said ?? ""), JSON.stringify(env)).toBe(realpathSync(want));
                expect(statSync(want).mode & 0o777).toBe(0o600);
                expect(statSync(path.dirname(want)).mode & 0o777).toBe(0o700);
                expect(leagueFilesUnder(r).map((f) => realpathSync(f))).toEqual([
                  realpathSync(want),
                ]);
              }
            },
          ),
          {
            numRuns: 40,
            examples: [
              // the reopened finding's inputs: an unexpanded tilde, and padding
              [`~/private/ff`, undefined],
              [`  ${path.join(base, "r", "abs", "pad")} `, undefined],
              [undefined, ` ${path.join(base, "r", "abs", "xdg")}\t`],
              ["rel/ff", undefined],
              ["~nobody/ff", undefined],
              [" \t ", "~/xdg"],
            ],
          },
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
