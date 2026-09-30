// qa1-045-unverified-rules.test.ts — Stage C QA round 1 regression: QA-1-045 an omitted rule/playoff field is named in rules.unverified_fields[] (skills/onboard §2
// "the field stays empty and is listed as unverified"; plan 07 A2 clean negatives).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edit, FIXTURE_TEXT, loadLeague, tempLeague, type TempLeague } from "./helpers.js";

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

const rulesOf = async (text: string) => (await loadLeague(t, text)).rules;

const RULES_BLOCK =
  "rules:\n  waiver_type: faab\n  waiver_time_days: 2\n  faab_budget: 100\n  trade_review: commissioner\n";
const PLAYOFFS_BLOCK = "  playoffs:\n    start_week: 15\n    num_teams: 6\n";

describe("QA-1-045: an omitted rule is unverified, never a silent fact", () => {
  it("rules and playoffs left out: every one is named in unverified_fields", async () => {
    const r = await rulesOf(edit(PLAYOFFS_BLOCK, "", edit(RULES_BLOCK, "")));
    expect(r.waiver_type).toBeNull();
    expect(r.faab_budget).toBeNull();
    expect(r.trade_ratify_type).toBeNull();
    expect(r.playoffs.start_week).toBeNull();
    expect(r.unverified_fields).toEqual(
      expect.arrayContaining([
        "waiver_type",
        "waiver_time_days",
        "uses_faab",
        "faab_budget",
        "trade_ratify_type",
        "playoffs",
      ]),
    );
    // capability stays conservative: unknown, never "no FAAB"
    expect(r.capabilities.tradeReviewMode).toBe("unknown");
  });

  it("stated fields are never listed; each omission is listed exactly when omitted", async () => {
    const full = await rulesOf(FIXTURE_TEXT);
    for (const f of [
      "waiver_type",
      "waiver_time_days",
      "uses_faab",
      "faab_budget",
      "trade_ratify_type",
      "playoffs",
    ])
      expect(full.unverified_fields).not.toContain(f);
    const cases: readonly (readonly [string, string, string])[] = [
      ["  waiver_type: faab\n", "", "waiver_type"],
      ["  waiver_time_days: 2\n", "", "waiver_time_days"],
      ["  faab_budget: 100\n", "", "faab_budget"],
      ["  trade_review: commissioner\n", "", "trade_ratify_type"],
      [PLAYOFFS_BLOCK, "", "playoffs"],
    ];
    for (const [from, to, field] of cases) {
      const r = await rulesOf(edit(from, to));
      expect(r.unverified_fields).toContain(field);
      expect(full.unverified_fields).not.toContain(field);
    }
    // a stated budget alone settles uses_faab; a stated non-FAAB type makes the budget moot
    expect((await rulesOf(edit("  waiver_type: faab\n", ""))).unverified_fields).not.toContain(
      "uses_faab",
    );
    const rolling = await rulesOf(
      edit("  faab_budget: 100\n", "", edit("waiver_type: faab", "waiver_type: rolling")),
    );
    expect(rolling.unverified_fields).not.toContain("faab_budget");
    expect(rolling.unverified_fields).not.toContain("uses_faab");
  });

  it("every listed name fits the tool's field grammar", async () => {
    const r = await rulesOf(edit(PLAYOFFS_BLOCK, "", edit(RULES_BLOCK, "")));
    expect(r.unverified_fields.length).toBeLessThanOrEqual(40);
    for (const f of r.unverified_fields) expect(f).toMatch(/^[a-z_]{1,40}$/);
    expect(new Set(r.unverified_fields).size).toBe(r.unverified_fields.length);
  });
});
