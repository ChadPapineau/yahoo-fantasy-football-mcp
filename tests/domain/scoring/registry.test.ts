// registry.test.ts — src/domain/scoring/registry.ts: plan 08 §3.1 (canonical registry, name patterns,
// position-type disambiguation, the Yahoo sample seed) and §4.2 (bonus-as-extra-id names).
import { describe, expect, it } from "vitest";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  bonusRuleTarget,
  normalizeStatName,
  REGISTRY,
  resolveCanonical,
  YAHOO_SAMPLE_STATS,
} from "../../../src/domain/scoring/registry.js";
import { CANONICAL_NAME_RE, KNOWN_CANONICAL } from "../../../src/domain/scoring/types.js";

/** Research 03 §B.5: id → the canonical the plan 08 §3.1 table assigns. */
const SAMPLE_CANONICAL: Record<string, string> = {
  "4": "pass_yd",
  "5": "pass_td",
  "6": "pass_int",
  "8": "rush_att",
  "9": "rush_yd",
  "10": "rush_td",
  "78": "targets",
  "11": "rec",
  "12": "rec_yd",
  "13": "rec_td",
  "15": "ret_td_off",
  "16": "two_pt",
  "18": "fum_lost",
  "57": "off_fum_ret_td",
  "19": "fg_0_19",
  "20": "fg_20_29",
  "21": "fg_30_39",
  "22": "fg_40_49",
  "23": "fg_50p",
  "29": "pat_made",
  "31": "dst_pa",
  "32": "dst_sack",
  "33": "dst_int",
  "34": "dst_fum_rec",
  "35": "dst_td",
  "36": "dst_safety",
  "37": "dst_blk",
  "49": "dst_ret_td",
  "82": "dst_xpr",
  "50": "dst_pa_0",
  "51": "dst_pa_1_6",
  "52": "dst_pa_7_13",
  "53": "dst_pa_14_20",
  "54": "dst_pa_21_27",
  "55": "dst_pa_28_34",
  "56": "dst_pa_35p",
};

describe("registry", () => {
  it("every row's canonical is a KNOWN_CANONICAL and every Yahoo id matches the §3.1 table", () => {
    for (const r of REGISTRY) {
      expect(KNOWN_CANONICAL).toContain(r.canonical);
      if (r.yahoo_id !== null)
        expect(SAMPLE_CANONICAL[r.yahoo_id] ?? r.canonical).toBe(r.canonical);
    }
    expect(Object.isFrozen(REGISTRY)).toBe(true);
  });

  it("resolves all 36 sample ids from their display names under their position type", () => {
    expect(Object.keys(YAHOO_SAMPLE_STATS)).toHaveLength(36);
    for (const [id, stat] of Object.entries(YAHOO_SAMPLE_STATS)) {
      expect({ id, c: resolveCanonical(stat.name, [stat.position_type]) }).toEqual({
        id,
        c: SAMPLE_CANONICAL[id],
      });
    }
  });

  it("covers every KNOWN_CANONICAL by a fixed row or a parametric name", () => {
    const fixed = new Set(REGISTRY.map((r) => r.canonical));
    const parametric = KNOWN_CANONICAL.filter((c) => !fixed.has(c));
    expect(parametric.every((c) => /^(fg|dst_pa)_\d/.test(c))).toBe(true);
  });

  it("disambiguates 'Interceptions' by position type and refuses a mixed rule", () => {
    expect(resolveCanonical("Interceptions", ["O"])).toBe("pass_int");
    expect(resolveCanonical("Interceptions", ["DT"])).toBe("dst_int");
    expect(resolveCanonical("Interception", ["DT"])).toBe("dst_int");
    expect(() => resolveCanonical("Interceptions", ["O", "DT"])).toThrow(ScoringError);
    try {
      resolveCanonical("Interceptions", ["DT", "O"]);
    } catch (e) {
      expect((e as ScoringError).code).toBe("ambiguous_canonical");
      expect((e as ScoringError).detail).toEqual(["Interceptions", "dst_int", "pass_int"]);
    }
  });

  it("resolves parametric bins, including non-default league bins", () => {
    const cases: [string, "K" | "DT", string | null][] = [
      ["Field Goals 0-29 Yards", "K", "fg_0_29"],
      ["Field Goals 40+ Yards", "K", "fg_40p"],
      ["Field Goals Missed 0-19 Yards", "K", "fg_miss_0_19"],
      ["Field Goals Missed 50+ Yards", "K", "fg_miss_50p"],
      ["Field Goals 40 Yards", "K", null],
      ["Field Goals abc Yards", "K", null],
      ["Field Goals 0-19", "K", null],
      ["Points Allowed 0", "DT", "dst_pa_0"],
      ["Points Allowed 007-013", "DT", "dst_pa_7_13"],
      ["Points Allowed 35+", "DT", "dst_pa_35p"],
      ["Yards Allowed 0-99", "DT", "dst_ya_0_99"],
      ["Yards Allowed 500+", "DT", "dst_ya_500p"],
      ["Yards Allowed 12345-99999", "DT", null],
      ["Total Yards Allowed", "DT", "dst_ya"],
    ];
    for (const [name, pt, want] of cases)
      expect({ name, got: resolveCanonical(name, [pt]) }).toEqual({ name, got: want });
    expect(resolveCanonical("Points Allowed 7-13", ["K"])).toBeNull();
    expect(resolveCanonical("Field Goals 20-29 Yards", ["DT"])).toBeNull();
  });

  it("normalises unicode dashes, case, NFKC and whitespace; unknown names are unmapped", () => {
    expect(normalizeStatName("  Points\tAllowed  7 – 13 ")).toBe("points allowed 7-13");
    expect(normalizeStatName("ＰＡＳＳＩＮＧ　Yards")).toBe("passing yards");
    expect(resolveCanonical("Points Allowed 7—13", ["DT"])).toBe("dst_pa_7_13");
    expect(resolveCanonical("PASSING YARDS", ["O"])).toBe("pass_yd");
    expect(resolveCanonical("Tackle Solo", ["D"])).toBeNull();
    expect(resolveCanonical("", ["O"])).toBeNull();
    expect(resolveCanonical("Passing Yards", [])).toBeNull();
    expect(resolveCanonical("<script>alert(1)</script>", ["O", "K", "DT", "D"])).toBeNull();
    expect(resolveCanonical("x".repeat(10_000), ["O"])).toBeNull();
  });

  it("every resolved canonical matches CANONICAL_NAME_RE", () => {
    for (const n of ["Field Goals 9999-9999 Yards", "Yards Allowed 9999+", "Points Allowed 9999"]) {
      const c = resolveCanonical(
        n,
        ["K", "DT"].includes("K") && n.startsWith("Field") ? ["K"] : ["DT"],
      );
      expect(c).not.toBeNull();
      expect(CANONICAL_NAME_RE.test(c!)).toBe(true);
    }
  });
});

describe("bonusRuleTarget (plan 08 §4.2)", () => {
  it.each([
    ["300+ Passing Yards Bonus", "pass_yd", 300],
    ["100+ Rushing Yard Bonus", "rush_yd", 100],
    ["100+ yard receiving bonus", "rec_yd", 100],
    ["Receiving Yards Bonus 200+", "rec_yd", 200],
  ])("%s → %s ≥ %d", (name, base, target) => {
    expect(bonusRuleTarget(name)).toEqual({ base, target });
  });

  it.each([["Passing Yards"], ["300 Passing Yards Bonus"], ["300+ Kicking Yards Bonus"], [""]])(
    "%s is not a bonus",
    (name) => {
      expect(bonusRuleTarget(name)).toBeNull();
    },
  );
});
