// onboard-scoring-keys.test.ts — QA-2-045 (the Skill half): what the onboard Skill, its league-file
// guide and the README FAQ say about scoring keys must be what the league file accepts (plan 09 §3.1
// manual mode; onboard §2 item 3 "every difference from the preset"). Every bracket key the file
// accepts beyond the preset's stats is named where the interview can find it, every key the text
// names loads, each yards-allowed example loads as written, and "a TE premium cannot be stated" is
// said exactly while the file refuses a per-position reception value.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  leagueFileSchema,
  normalizeLeague,
  parseLeagueYaml,
} from "../../src/providers/manual/index.js";
import { DST_YA_BINS, FG_MISS_BINS } from "../../src/providers/manual/schema.js";
import { ROOT } from "./helpers.js";

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SKILL = read("skills/onboard/SKILL.md");
const GUIDE = read("skills/onboard/references/onboard-league-yaml.md");
const README = read("README.md");
const TEXTS = [
  ["skills/onboard/SKILL.md", SKILL],
  ["skills/onboard/references/onboard-league-yaml.md", GUIDE],
  ["README.md", README],
] as const;

/** The guide's one YAML example, parsed: every probe below edits a copy of it. */
const EXAMPLE = (() => {
  const yaml = /^```yaml\n([\s\S]*?)^```/m.exec(GUIDE)?.[1];
  if (yaml === undefined) throw new Error("the guide has no YAML example");
  return parseLeagueYaml(yaml) as { scoring: { overrides?: Record<string, number> } };
})();

/** Whether a league file with these overrides (on top of the example's) loads: schema + model. */
function loads(overrides: Record<string, number>): { ok: boolean; why: string } {
  const file = structuredClone(EXAMPLE);
  file.scoring.overrides = { ...file.scoring.overrides, ...overrides };
  const parsed = leagueFileSchema.safeParse(file);
  if (!parsed.success) return { ok: false, why: JSON.stringify(parsed.error.issues) };
  const model = normalizeLeague(parsed.data);
  return model.ok ? { ok: true, why: "" } : { ok: false, why: JSON.stringify(model.issues) };
}

/** The stats the league file accepts beyond the presets' own: the two bin families. */
const BIN_KEYS = [...FG_MISS_BINS, ...DST_YA_BINS];

/** The §2 interview item about scoring in the Skill. */
const SCORING_ITEM = /^3\. Scoring\b.*$/m.exec(SKILL)?.[0] ?? "";

describe("QA-2-045: the onboard guide names every bracket key the league file accepts", () => {
  it.each(BIN_KEYS)("names `%s`", (key) => {
    expect(GUIDE).toContain(`\`${key}\``);
  });

  it("every fg_miss_* / dst_ya_* key the onboard text or the README names is one the file accepts", () => {
    const named = new Set<string>();
    for (const [, text] of TEXTS)
      for (const m of text.matchAll(/\b((?:fg_miss|dst_ya)_[a-z0-9_]+)\b/g)) named.add(m[1] ?? "");
    expect(named.size).toBeGreaterThan(0);
    for (const key of named) expect(BIN_KEYS, key).toContain(key);
  });

  it("each yards-allowed example the guide gives loads exactly as written", () => {
    // an inline example: `dst_ya_0_99: 5, dst_ya_100_199: 3, …` (one code span per bin, comma-joined)
    const examples = [...GUIDE.matchAll(/(?:`dst_ya_[a-z0-9_]+: -?\d+(?:\.\d+)?`(?:, )?)+/g)].map(
      (m) =>
        Object.fromEntries(
          [...m[0].matchAll(/`(dst_ya_[a-z0-9_]+): (-?\d+(?:\.\d+)?)`/g)].map((x) => [
            x[1] ?? "",
            Number(x[2]),
          ]),
        ),
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(Object.keys(ex).length, JSON.stringify(ex)).toBeGreaterThan(1);
      const r = loads(ex);
      expect(r.ok, `${JSON.stringify(ex)}: ${r.why}`).toBe(true);
      // and the rule the guide states is the file's: leave out any one bin and it does not load
      for (const k of Object.keys(ex)) {
        const { [k]: _gone, ...rest } = ex;
        expect(loads(rest).ok, `without ${k}`).toBe(false);
      }
    }
  });

  it("the guide states the yards-allowed rule: from 0 to one open-ended bin, 0-point bins listed", () => {
    expect(GUIDE).toMatch(/from 0[^.]*open-ended bin/i);
    expect(GUIDE).toMatch(/(?:worth|scoring) 0[^.]*(?:too|included)|0-point bins/i);
  });

  it("the interview's scoring item asks about missed field goals and yards allowed, by key", () => {
    expect(SCORING_ITEM).toMatch(/missed field goals?/i);
    expect(SCORING_ITEM).toMatch(/yards[- ]allowed/i);
    expect(SCORING_ITEM).toContain("fg_miss_");
    expect(SCORING_ITEM).toContain("dst_ya_");
  });
});

describe("QA-2-045: a TE premium is said to be unstateable exactly while the file refuses it", () => {
  /** Per-position reception values a TE premium would need; none is a key today. */
  const PER_POSITION = ["rec_te", "te_rec", "rec_bonus_te"];
  const refused = PER_POSITION.every((k) => !loads({ [k]: 0.5 }).ok);
  const CANNOT = /TE premium[^.]*cannot be stated|cannot state[^.]*TE premium/i;
  const WHAT_IT_OMITS = /read(?:s)? low[^.]*premium × receptions|premium × receptions/i;

  it("the league file refuses every per-position reception key probed", () => {
    // when this fails a TE premium can be stated: drop the claim below and document the key
    expect(refused).toBe(true);
  });

  it.each([
    ["the interview's scoring item", SCORING_ITEM],
    ["the guide", GUIDE],
    ["the README FAQ", README],
  ])("%s says a TE premium cannot be stated, and what that omits", (_label, text) => {
    expect(CANNOT.test(text)).toBe(refused);
    expect(text).toMatch(WHAT_IT_OMITS);
  });
});
