// rules.test.ts — the league-rule predicates (plan 01 §8 hasFaab / waiverProcessingDays /
// tradeReviewMode; unknown platform values map conservatively).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  hasFaab,
  isAdmissibleBid,
  ruleCapabilities,
  tradeReviewMode,
  tradesCanBeVetoed,
  waiverKind,
  waiverProcessingDays,
} from "../../../src/domain/league/rules.js";
import type { LeagueRules } from "../../../src/domain/league/types.js";

function rules(
  over: Partial<LeagueRules> & { uses_faab: boolean; trade_ratify_type?: string | null },
): LeagueRules {
  const base = {
    waiver_type: null,
    waiver_rule: null,
    waiver_time_days: 2,
    faab_budget: 100,
    trade_end_date: null,
    trade_ratify_type: null,
    trade_reject_time_days: null,
    can_trade_draft_picks: null,
    max_adds: null,
    max_weekly_adds: null,
    uses_median_score: null,
    playoffs: {
      uses_playoff: false,
      start_week: null,
      num_teams: null,
      reseeding: null,
      multiweek_championship: null,
      consolation_teams: null,
    },
    player_pool: null,
    cant_cut_list: null,
    allow_add_to_dl_extra_pos: null,
    unverified_fields: [],
    ...over,
  };
  return {
    ...base,
    capabilities: ruleCapabilities({
      uses_faab: base.uses_faab,
      waiver_time_days: base.waiver_time_days,
      trade_ratify_type: base.trade_ratify_type,
    }),
  };
}

describe("tradeReviewMode", () => {
  it("maps known spellings and treats everything else as unknown", () => {
    expect(tradeReviewMode("commish")).toBe("commissioner");
    expect(tradeReviewMode(" Commissioner ")).toBe("commissioner");
    expect(tradeReviewMode("vote")).toBe("league_vote");
    expect(tradeReviewMode("league_vote")).toBe("league_vote");
    expect(tradeReviewMode("none")).toBe("none");
    expect(tradeReviewMode(null)).toBe("unknown");
    expect(tradeReviewMode("")).toBe("unknown");
    expect(tradeReviewMode("__proto__")).toBe("unknown");
    expect(tradeReviewMode("constructor")).toBe("unknown");
  });
});

describe("waiverKind", () => {
  it("FAAB wins when the flag says so; spellings map; contradictions are unknown", () => {
    expect(waiverKind(null, true)).toBe("faab");
    expect(waiverKind("rolling", true)).toBe("faab");
    expect(waiverKind("rolling", false)).toBe("priority");
    expect(waiverKind("R", false)).toBe("priority");
    expect(waiverKind("continual", false)).toBe("priority");
    expect(waiverKind("none", false)).toBe("none");
    expect(waiverKind("faab", false)).toBe("unknown");
    expect(waiverKind("FR", false)).toBe("unknown");
    expect(waiverKind(null, false)).toBe("unknown");
    expect(waiverKind("toString", false)).toBe("unknown");
  });
});

describe("waiverProcessingDays / ruleCapabilities", () => {
  it("keeps 0..14 integers, else null", () => {
    expect(waiverProcessingDays(0)).toBe(0);
    expect(waiverProcessingDays(14)).toBe(14);
    for (const d of [null, -1, 15, 1.5, Number.NaN, Infinity])
      expect(waiverProcessingDays(d)).toBeNull();
  });

  it("derives the three predicates", () => {
    expect(
      ruleCapabilities({ uses_faab: true, waiver_time_days: 2, trade_ratify_type: "vote" }),
    ).toEqual({
      hasFaab: true,
      waiverProcessingDays: 2,
      tradeReviewMode: "league_vote",
    });
  });
});

describe("rule predicates on LeagueRules", () => {
  it("hasFaab and tradesCanBeVetoed read the derived capabilities", () => {
    expect(hasFaab(rules({ uses_faab: true }))).toBe(true);
    expect(hasFaab(rules({ uses_faab: false }))).toBe(false);
    expect(tradesCanBeVetoed(rules({ uses_faab: false, trade_ratify_type: "vote" }))).toBe(true);
    expect(tradesCanBeVetoed(rules({ uses_faab: false, trade_ratify_type: "commish" }))).toBe(
      false,
    );
  });

  it("isAdmissibleBid: integer 0..balance (or budget when the balance is unknown)", () => {
    const r = rules({ uses_faab: true, faab_budget: 100 });
    expect(isAdmissibleBid(r, 0, null)).toBe(true);
    expect(isAdmissibleBid(r, 100, null)).toBe(true);
    expect(isAdmissibleBid(r, 101, null)).toBe(false);
    expect(isAdmissibleBid(r, 40, 35)).toBe(false);
    expect(isAdmissibleBid(r, 35, 35)).toBe(true);
    expect(isAdmissibleBid(r, -1, null)).toBe(false);
    expect(isAdmissibleBid(r, 1.5, null)).toBe(false);
    expect(isAdmissibleBid(rules({ uses_faab: false }), 1, 100)).toBe(false);
    expect(isAdmissibleBid(rules({ uses_faab: true, faab_budget: null }), 1, null)).toBe(false);
  });

  it("never admits a bid above the cap (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 2000 }),
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
        (bid, bal) => {
          const r = rules({ uses_faab: true, faab_budget: 100 });
          if (isAdmissibleBid(r, bid, bal)) {
            expect(bid).toBeGreaterThanOrEqual(0);
            expect(bid).toBeLessThanOrEqual(bal ?? 100);
          }
        },
      ),
    );
  });
});
