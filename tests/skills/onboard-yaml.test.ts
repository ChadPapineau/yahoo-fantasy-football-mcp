// onboard-yaml.test.ts — the onboard Skill's league-file guide (plan 09 §3.1 manual mode, plan 10
// §3.1a) must show YAML the server actually accepts: its example is parsed with the provider's own
// hardened parser and validated against its schema, so a schema change that the Skill does not
// follow fails here instead of in the user's terminal.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLeagueFilePath, resolveConfigDir } from "../../src/config/paths.js";
import { leagueFileSchema, parseLeagueYaml } from "../../src/providers/manual/index.js";
import { FIXTURE_LEAGUE } from "../mcp/helpers/env.js";
import { ROOT } from "./helpers.js";

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

/** The guide's save commands (the one ```sh block under "Saving it"). */
const saveBlocks = [...guide.matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");

/**
 * Runs the guide's save commands in `sh` as a user would paste them, under a private HOME and the
 * given environment. The "save the YAML … with any editor" comment line stands for the user's
 * editor: it is replaced by a copy of the fixture league to the very path the next `chmod 600`
 * line names (so the test follows the guide's path, whatever it is), and `ff` is a stub that logs.
 */
function runSaveSteps(
  env: Record<string, string>,
  home: string,
): { stdout: string; ffLog: string } {
  const block = saveBlocks[0] ?? "";
  const target = /^chmod 600 (.+)$/m.exec(block)?.[1];
  if (target === undefined) throw new Error("the save commands have no `chmod 600 <file>` line");
  const script = block
    .split("\n")
    .map((l) => (l.startsWith("# save the YAML") ? `cp "$FF_TEST_YAML" ${target}` : l))
    .join("\n");
  const log = path.join(home, "..", "ff.log");
  const r = spawnSync("/bin/sh", ["-c", `ff() { echo "ff $*" >> "$FF_TEST_LOG"; }\n${script}`], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      FF_TEST_YAML: FIXTURE_LEAGUE,
      FF_TEST_LOG: log,
      ...env,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return { stdout: r.stdout, ffLog: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

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
        const { ffLog } = runSaveSteps(env, home);
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
