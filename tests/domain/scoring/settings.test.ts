// settings.test.ts — src/domain/scoring/settings.ts: plan 08 §2 (settings_hash without `verified`),
// §3.1 (resolution, unmapped once per hash, duplicate canonical = loud error), §4.2 (bonus folding),
// §4.4 (flag defaults), P7 (idempotence, order-independence), hostile drafts.
import { describe, expect, it } from "vitest";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  canonicalJson,
  computeSettingsHash,
  createUnmappedLog,
  MAX_BONUSES,
  MAX_RULES,
  normalizeSettings,
  type RuleDraft,
  type SettingsDraft,
  unmappedIds,
} from "../../../src/domain/scoring/settings.js";
import { draftOf, loadDraft, sampleSettings } from "./fixtures.js";

const base = (): SettingsDraft => loadDraft("sample-league");
const r = (over: Partial<RuleDraft> & { platform_id: string }): RuleDraft => ({
  name: "Passing Yards",
  position_types: ["O"],
  modifier: 1,
  ...over,
});
const draft = (rules: unknown[], over: Record<string, unknown> = {}): SettingsDraft =>
  ({
    platform: "manual",
    uses_fractional_points: true,
    uses_negative_points: true,
    rules,
    ...over,
  }) as unknown as SettingsDraft;

function errorOf(fn: () => unknown): ScoringError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ScoringError);
    return e as ScoringError;
  }
  throw new Error("expected a throw");
}

describe("normalizeSettings — shape", () => {
  it("resolves canonicals by name, sorts rules by id, freezes deeply, hashes to hex", () => {
    const s = sampleSettings();
    expect(s.rules).toHaveLength(36);
    expect(s.rules.find((x) => x.platform_id === "6")!.canonical).toBe("pass_int");
    expect(s.rules.find((x) => x.platform_id === "33")!.canonical).toBe("dst_int");
    const ids = s.rules.map((x) => x.platform_id);
    expect(ids).toEqual([...ids].sort());
    expect(s.settings_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.rules[0]!.position_types)).toBe(true);
    expect(Object.isFrozen(s.rounding)).toBe(true);
    expect(unmappedIds(s)).toEqual([]);
  });

  it("defaults the flags: exact rounding unverified; floor scope follows uses_negative_points", () => {
    const neg = sampleSettings();
    expect(neg.rounding).toEqual({ mode: "exact", verified: false });
    expect(neg.negative_floor).toEqual({ scope: "none", verified: false });
    const noNeg = sampleSettings({ set: { uses_negative_points: false } });
    expect(noNeg.negative_floor).toEqual({ scope: "player_week_total", verified: false });
    const explicit = sampleSettings({
      set: {
        rounding: { mode: "floor_total", verified: true },
        negative_floor: { scope: "custom_scope", verified: true },
      },
    });
    expect(explicit.rounding).toEqual({ mode: "floor_total", verified: true });
    expect(explicit.negative_floor).toEqual({ scope: "custom_scope", verified: true });
  });

  it("keeps an explicit null canonical unmapped and an explicit canonical as given", () => {
    const s = normalizeSettings(
      draft([
        r({ platform_id: "1", canonical: null }),
        r({ platform_id: "2", name: "Anything", canonical: "rec" }),
      ]),
    );
    expect(s.rules.map((x) => x.canonical)).toEqual([null, "rec"]);
    expect(unmappedIds(s)).toEqual(["1"]);
  });

  it("normalises -0 modifiers and bonus values, dedupes and orders position types", () => {
    const s = normalizeSettings(
      draft([
        r({
          platform_id: "1",
          modifier: -0,
          position_types: ["D", "O", "D"],
          canonical: "x_1",
          bonuses: [{ target: -0, points: -0 }],
        }),
      ]),
    );
    const rule = s.rules[0]!;
    expect(Object.is(rule.modifier, 0)).toBe(true);
    expect(rule.position_types).toEqual(["O", "D"]);
    expect(Object.is(rule.bonuses[0]!.target, 0)).toBe(true);
    expect(Object.is(rule.bonuses[0]!.points, 0)).toBe(true);
  });

  it("sorts bonuses by target then points", () => {
    const s = normalizeSettings(
      draft([
        r({
          platform_id: "9",
          name: "Rushing Yards",
          bonuses: [
            { target: 200, points: 5 },
            { target: 100, points: 3 },
            { target: 100, points: 1 },
          ],
        }),
      ]),
    );
    expect(s.rules[0]!.bonuses).toEqual([
      { target: 100, points: 1 },
      { target: 100, points: 3 },
      { target: 200, points: 5 },
    ]);
  });

  it("orders rules sharing an id by canonical, position types, then name", () => {
    const s = normalizeSettings(
      draft([
        r({ platform_id: "7", canonical: null, name: "b", position_types: ["O"] }),
        r({ platform_id: "7", canonical: null, name: "a", position_types: ["O"] }),
        r({ platform_id: "7", canonical: null, name: "c", position_types: ["K"] }),
        r({ platform_id: "7", canonical: "rec", name: "z" }),
      ]),
    );
    expect(s.rules.map((x) => [x.canonical, x.position_types.join(), x.name])).toEqual([
      [null, "K", "c"],
      [null, "O", "a"],
      [null, "O", "b"],
      ["rec", "O", "z"],
    ]);
  });
});

describe("normalizeSettings — bonus folding (plan 08 §4.2)", () => {
  it("folds a bonus stat id onto the base rule and removes it", () => {
    const s = sampleSettings({
      add_rules: [
        {
          platform_id: "901",
          name: "200+ Rushing Yards Bonus",
          position_types: ["O"],
          modifier: 5,
        },
        {
          platform_id: "900",
          name: "100+ Rushing Yards Bonus",
          position_types: ["O"],
          modifier: 3,
        },
      ],
    });
    expect(s.rules.some((x) => x.platform_id === "900" || x.platform_id === "901")).toBe(false);
    expect(s.rules.find((x) => x.platform_id === "9")!.bonuses).toEqual([
      { target: 100, points: 3 },
      { target: 200, points: 5 },
    ]);
  });

  it("synthesises a display-only base rule when the base stat is absent, and stays idempotent", () => {
    const d = draft([
      r({ platform_id: "900", name: "300+ Passing Yards Bonus", modifier: 3 }),
      r({ platform_id: "901", name: "400+ Passing Yards Bonus", modifier: 2 }),
    ]);
    const s = normalizeSettings(d);
    expect(s.rules).toEqual([
      {
        canonical: "pass_yd",
        platform_id: "900",
        name: "300+ Passing Yards Bonus",
        position_types: ["O"],
        modifier: null,
        bonuses: [
          { target: 300, points: 3 },
          { target: 400, points: 2 },
        ],
      },
    ]);
    expect(normalizeSettings(s)).toEqual(s);
  });

  it("does not fold a display-only bonus id or one whose base is in another position type", () => {
    const s = normalizeSettings(
      draft([
        r({ platform_id: "900", name: "100+ Rushing Yards Bonus", modifier: null }),
        r({ platform_id: "9", name: "Rushing Yards", canonical: "rush_yd", position_types: ["D"] }),
        r({
          platform_id: "901",
          name: "100+ Rushing Yards Bonus",
          modifier: 4,
          position_types: ["O"],
        }),
      ]),
    );
    expect(s.rules.find((x) => x.platform_id === "900")!.canonical).toBeNull();
    expect(s.rules.find((x) => x.platform_id === "9")!.bonuses).toEqual([]);
    const synth = s.rules.find((x) => x.platform_id === "901")!;
    expect(synth).toMatchObject({ canonical: "rush_yd", modifier: null, position_types: ["O"] });
  });

  it("attaches to every base rule sharing a position type", () => {
    const s = normalizeSettings(
      draft([
        r({ platform_id: "9", name: "Rushing Yards", position_types: ["O"] }),
        r({
          platform_id: "9d",
          name: "Rushing Yards",
          canonical: "rush_yd",
          position_types: ["D"],
        }),
        r({
          platform_id: "900",
          name: "100+ Rushing Yards Bonus",
          modifier: 2,
          position_types: ["O", "D"],
        }),
      ]),
    );
    for (const id of ["9", "9d"]) {
      expect(s.rules.find((x) => x.platform_id === id)!.bonuses).toEqual([
        { target: 100, points: 2 },
      ]);
    }
  });
});

describe("normalizeSettings — refusals", () => {
  it("refuses two rules on one canonical in one position type, naming both ids", () => {
    const e = errorOf(() =>
      normalizeSettings(
        draft([r({ platform_id: "4" }), r({ platform_id: "900", name: "passing yards" })]),
      ),
    );
    expect(e.code).toBe("duplicate_canonical");
    expect(e.detail).toEqual(["4", "900"]);
    // the same canonical under two different position types is fine
    expect(() =>
      normalizeSettings(
        draft([
          r({ platform_id: "a", canonical: "x_1", position_types: ["O"] }),
          r({ platform_id: "b", canonical: "x_1", position_types: ["D"] }),
        ]),
      ),
    ).not.toThrow();
  });

  it.each<[string, SettingsDraft, string]>([
    ["unknown platform", draft([], { platform: "fantasy_pros" }), "invalid_settings"],
    ["non-boolean fractional", draft([], { uses_fractional_points: "yes" }), "invalid_settings"],
    ["non-boolean negative", draft([], { uses_negative_points: 1 }), "invalid_settings"],
    ["rules not an array", draft([], { rules: {} }), "invalid_settings"],
    [
      "too many rules",
      draft(
        Array.from({ length: MAX_RULES + 1 }, (_, i) =>
          r({ platform_id: String(i), canonical: null }),
        ),
      ),
      "invalid_settings",
    ],
    ["null rule", draft([null]), "invalid_settings"],
    ["string rule", draft(["pass_yd"]), "invalid_settings"],
    ["numeric id", draft([{ ...r({ platform_id: "x" }), platform_id: 4 }]), "invalid_settings"],
    ["empty id", draft([r({ platform_id: "" })]), "invalid_settings"],
    ["long id", draft([r({ platform_id: "9".repeat(65) })]), "invalid_settings"],
    ["control char id", draft([r({ platform_id: "4\u0000" })]), "invalid_settings"],
    ["C1 control id", draft([r({ platform_id: "4\u0085" })]), "invalid_settings"],
    ["name not string", draft([{ ...r({ platform_id: "1" }), name: 4 }]), "invalid_settings"],
    ["long name", draft([r({ platform_id: "1", name: "x".repeat(201) })]), "invalid_settings"],
    ["NaN modifier", draft([r({ platform_id: "1", modifier: NaN })]), "invalid_settings"],
    ["Infinity modifier", draft([r({ platform_id: "1", modifier: Infinity })]), "invalid_settings"],
    ["huge modifier", draft([r({ platform_id: "1", modifier: 1e7 })]), "invalid_settings"],
    [
      "string modifier",
      draft([{ ...r({ platform_id: "1" }), modifier: "0.04" }]),
      "invalid_settings",
    ],
    [
      "missing modifier",
      draft([{ platform_id: "1", name: "x", position_types: ["O"] }]),
      "invalid_settings",
    ],
    ["bad canonical", draft([r({ platform_id: "1", canonical: "Pass Yds" })]), "invalid_canonical"],
    [
      "numeric canonical",
      draft([{ ...r({ platform_id: "1" }), canonical: 4 }]),
      "invalid_canonical",
    ],
    [
      "position types not array",
      draft([{ ...r({ platform_id: "1" }), position_types: "O" }]),
      "invalid_settings",
    ],
    [
      "unknown position type",
      draft([{ ...r({ platform_id: "1" }), position_types: ["QB"] }]),
      "invalid_settings",
    ],
    [
      "bonuses not array",
      draft([{ ...r({ platform_id: "1" }), bonuses: { target: 1 } }]),
      "invalid_settings",
    ],
    [
      "too many bonuses",
      draft([
        r({
          platform_id: "1",
          bonuses: Array.from({ length: MAX_BONUSES + 1 }, (_, i) => ({ target: i, points: 1 })),
        }),
      ]),
      "invalid_settings",
    ],
    ["null bonus", draft([{ ...r({ platform_id: "1" }), bonuses: [null] }]), "invalid_settings"],
    [
      "NaN bonus target",
      draft([r({ platform_id: "1", bonuses: [{ target: NaN, points: 1 }] })]),
      "invalid_settings",
    ],
    [
      "huge bonus points",
      draft([r({ platform_id: "1", bonuses: [{ target: 1, points: 1e9 }] })]),
      "invalid_settings",
    ],
    [
      "ambiguous name",
      draft([r({ platform_id: "1", name: "Interceptions", position_types: ["O", "DT"] })]),
      "ambiguous_canonical",
    ],
    [
      "bracket gap",
      draft([
        r({ platform_id: "1", canonical: "dst_pa_0", position_types: ["DT"] }),
        r({ platform_id: "2", canonical: "dst_pa_5p", position_types: ["DT"] }),
      ]),
      "bracket_bounds",
    ],
    [
      "rounding.verified not boolean",
      draft([], { rounding: { mode: "exact", verified: "no" } }),
      "invalid_settings",
    ],
    ["rounding not an object", draft([], { rounding: "exact" }), "invalid_settings"],
    [
      "floor.verified missing",
      draft([], { negative_floor: { scope: "none" } }),
      "invalid_settings",
    ],
    [
      "rounding mode not identifier",
      draft([], { rounding: { mode: "Round Half Up", verified: false } }),
      "invalid_settings",
    ],
    [
      "floor scope not string",
      draft([], { negative_floor: { scope: 3, verified: false } }),
      "invalid_settings",
    ],
  ])("%s", (_, d, code) => {
    expect(errorOf(() => normalizeSettings(d)).code).toBe(code);
  });

  it("accepts the maximum sizes", () => {
    const rules = Array.from({ length: MAX_RULES }, (_, i) =>
      r({ platform_id: String(i), canonical: null }),
    );
    expect(normalizeSettings(draft(rules)).rules).toHaveLength(MAX_RULES);
  });
});

describe("settings_hash (plan 08 §2, P7)", () => {
  it("is independent of rule, position-type and bonus order", () => {
    const a = normalizeSettings(base());
    const b = normalizeSettings(draftOf({ base: "sample-league", reverse_rules: true }));
    expect(b.settings_hash).toBe(a.settings_hash);
    expect(b).toEqual(a);
    const c1 = normalizeSettings(
      draft([
        r({
          platform_id: "1",
          position_types: ["O", "K"],
          bonuses: [
            { target: 1, points: 1 },
            { target: 2, points: 1 },
          ],
        }),
      ]),
    );
    const c2 = normalizeSettings(
      draft([
        r({
          platform_id: "1",
          position_types: ["K", "O"],
          bonuses: [
            { target: 2, points: 1 },
            { target: 1, points: 1 },
          ],
        }),
      ]),
    );
    expect(c2.settings_hash).toBe(c1.settings_hash);
  });

  it("changes with any modifier, flag, name or platform — and not with a verified flag", () => {
    const a = sampleSettings();
    expect(sampleSettings({ modifiers: { "4": 0.05 } }).settings_hash).not.toBe(a.settings_hash);
    expect(sampleSettings({ set: { uses_fractional_points: false } }).settings_hash).not.toBe(
      a.settings_hash,
    );
    expect(normalizeSettings({ ...base(), platform: "manual" }).settings_hash).not.toBe(
      a.settings_hash,
    );
    const renamed = base().rules.map((x) =>
      x.platform_id === "8" ? { ...x, name: "Rushing Attempts " } : x,
    );
    expect(normalizeSettings({ ...base(), rules: renamed }).settings_hash).not.toBe(
      a.settings_hash,
    );
    const verified = sampleSettings({
      set: {
        rounding: { mode: "exact", verified: true },
        negative_floor: { scope: "none", verified: true },
      },
    });
    expect(verified.settings_hash).toBe(a.settings_hash);
    expect(
      sampleSettings({ set: { rounding: { mode: "floor_total", verified: false } } }).settings_hash,
    ).not.toBe(a.settings_hash);
  });

  it("ignores a draft's stale brackets and hash (always re-derived) and is idempotent", () => {
    const a = sampleSettings();
    const stale = { ...a, brackets: [], settings_hash: "0".repeat(64) };
    expect(normalizeSettings(stale)).toEqual(a);
    expect(normalizeSettings(normalizeSettings(a))).toEqual(a);
    expect(computeSettingsHash(a)).toBe(a.settings_hash);
  });

  it("canonicalJson sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined })).toBe(
      '{"a":[{"c":null,"d":2}],"b":1}',
    );
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson({ " k": "é" })).toBe(JSON.stringify({ " k": "é" }));
  });
});

describe("createUnmappedLog (logged once per settings_hash)", () => {
  const withUnmapped = (id: string) =>
    normalizeSettings(draft([r({ platform_id: id, name: "Tackle Solo", position_types: ["D"] })]));

  it("reports once per hash, never for an empty list, and forgets the oldest past capacity", () => {
    const log = createUnmappedLog(2);
    const a = withUnmapped("a");
    const b = withUnmapped("b");
    const c = withUnmapped("c");
    expect(log.firstReport(a)).toEqual(["a"]);
    expect(log.firstReport(a)).toBeNull();
    expect(log.firstReport(sampleSettings())).toBeNull();
    expect(log.firstReport(b)).toEqual(["b"]);
    expect(log.firstReport(c)).toEqual(["c"]);
    expect(log.firstReport(a)).toEqual(["a"]); // evicted, so reported again
  });

  it("rejects a non-positive or fractional capacity and defaults to 256", () => {
    expect(() => createUnmappedLog(0)).toThrow(RangeError);
    expect(() => createUnmappedLog(1.5)).toThrow(RangeError);
    expect(createUnmappedLog().firstReport(withUnmapped("z"))).toEqual(["z"]);
  });

  it("dedupes ids repeated across rules", () => {
    const s = normalizeSettings(
      draft([
        r({ platform_id: "7", name: "Tackle Solo", position_types: ["D"] }),
        r({ platform_id: "7", name: "Tackle Assist", position_types: ["D"] }),
      ]),
    );
    expect(unmappedIds(s)).toEqual(["7"]);
  });
});
