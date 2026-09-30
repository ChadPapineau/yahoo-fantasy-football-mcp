// onboard-yaml.test.ts — the onboard Skill's league-file guide (plan 09 §3.1 manual mode, plan 10
// §3.1a) must show YAML the server actually accepts: its example is parsed with the provider's own
// hardened parser and validated against its schema, so a schema change that the Skill does not
// follow fails here instead of in the user's terminal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { leagueFileSchema, parseLeagueYaml } from "../../src/providers/manual/index.js";
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

  it("the save steps set 0700 on the directory and 0600 on the file", () => {
    expect(guide).toMatch(/umask 077/);
    expect(guide).toMatch(/chmod 700 ~\/\.config\/fantasy-football-mcp\n/);
    expect(guide).toMatch(/chmod 600 ~\/\.config\/fantasy-football-mcp\/league\.yaml\n/);
  });
});
