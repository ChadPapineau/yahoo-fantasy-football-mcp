// edge.test.ts — plan 08 §8: every edge case is a named fixture in fixtures/golden/edge/cases with
// its expected output (hand-computed), plus the frozen manifest (plan 08 §6.1: an engine or fixture
// change that silently alters a score fails even when the inputs are unchanged).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { score } from "../../../src/domain/scoring/engine.js";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  rebinKickLine,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "../../../src/domain/scoring/nflverse.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { ScoreResult, ScoringSettings, StatLine } from "../../../src/domain/scoring/types.js";
import { draftOf, EDGE_DIR, edgeCases, type EdgeCheck, type ExpectedScore } from "./fixtures.js";

/** The §8 rows, by fixture name — the test fails if a row loses its fixture. */
const PLAN_08_SECTION_8 = [
  "empty-line-final",
  "empty-line-provisional",
  "unknown-stat-ids-in-line",
  "unmapped-settings-id",
  "k-zero-value-distance",
  "k-kick-distance-boundary",
  "dst-zero-points-allowed",
  "dst-not-started-provisional",
  "dst-two-indicators",
  "negative-total-no-negative-league",
  "multi-target-bonus",
  "bonus-as-extra-stat-id",
  "player-return-td",
  "dst-return-td",
  "two-pt-pass-rush-rec",
  "qb-sack-fumble-lost",
  "fractional-modifiers",
  "bye-week-final",
  "ir-player-with-line",
  "settings-change-mid-season",
  "duplicate-canonical",
  "categories-order-differs",
];

function lineFor(check: EdgeCheck, settings: ScoringSettings): StatLine {
  let line: StatLine;
  if (check.nflverse_player !== undefined) line = statLineFromPlayerWeek(check.nflverse_player);
  else if (check.nflverse_defense !== undefined) {
    line = statLineFromTeamDefense(check.nflverse_defense.row, {
      pointsAllowed: check.nflverse_defense.points_allowed,
    });
  } else {
    const l = check.line!;
    line = {
      values: l.values,
      present: Object.keys(l.values).sort(),
      position_type: l.position_type,
      provisional: l.provisional,
      source: "fixture",
    };
  }
  return check.made_list === undefined ? line : rebinKickLine(line, settings, check.made_list);
}

function assertScore(r: ScoreResult, e: ExpectedScore, settings: ScoringSettings): void {
  expect(r.points).toBe(e.points);
  expect(r.points_exact).toBe(e.points_exact);
  expect(r.complete).toBe(e.complete);
  expect(r.unmapped).toEqual(e.unmapped);
  expect(r.ignored).toEqual(e.ignored);
  if (e.contributions !== undefined) expect(r.contributions).toHaveLength(e.contributions);
  if (e.contribution_points !== undefined) {
    const got = Object.fromEntries(r.contributions.map((c) => [c.canonical, c.points]));
    expect(got).toEqual(e.contribution_points);
  }
  if (e.negative_floor !== undefined) expect(settings.negative_floor).toEqual(e.negative_floor);
  expect(Number.isFinite(r.points)).toBe(true);
}

describe("plan 08 §8 edge-case fixtures", () => {
  const cases = edgeCases();

  it("has a fixture for every §8 row, each named after its file", () => {
    const names = cases.map((c) => c.body.name);
    for (const row of PLAN_08_SECTION_8) expect(names).toContain(row);
    for (const c of cases) expect(c.file).toBe(`${c.body.name}.json`);
  });

  for (const { body } of cases) {
    it(`${body.name} — ${body.case}`, () => {
      if (body.settings_error !== undefined) {
        const err = (() => {
          try {
            normalizeSettings(draftOf(body.settings));
          } catch (e) {
            return e;
          }
          return null;
        })();
        expect(err).toBeInstanceOf(ScoringError);
        expect((err as ScoringError).code).toBe(body.settings_error.code);
        expect((err as ScoringError).detail).toEqual(body.settings_error.detail);
        return;
      }
      const settings = normalizeSettings(draftOf(body.settings));
      const other =
        body.compare === undefined ? null : normalizeSettings(draftOf(body.compare.settings));
      if (body.compare !== undefined && other !== null) {
        expect(settings.settings_hash === other.settings_hash).toBe(body.compare.same_hash);
      }
      for (const check of body.checks ?? []) {
        const line = lineFor(check, settings);
        if (check.expected_error !== undefined) {
          const want = check.expected_error;
          expect(() => score(line, settings)).toThrow(ScoringError);
          try {
            score(line, settings);
          } catch (e) {
            expect((e as ScoringError).code).toBe(want.code);
            expect((e as ScoringError).detail).toEqual(expect.arrayContaining([...want.detail]));
          }
          continue;
        }
        assertScore(score(line, settings), check.expected!, settings);
        if (check.expected_compare !== undefined && other !== null) {
          assertScore(score(lineFor(check, other), other), check.expected_compare, other);
        }
      }
    });
  }
});

describe("frozen golden manifest (plan 08 §6.1)", () => {
  it("lists every edge fixture with its sha256, and nothing else", () => {
    const manifest = JSON.parse(readFileSync(join(EDGE_DIR, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
    };
    const onDisk = ["settings", "cases"].flatMap((d) =>
      readdirSync(join(EDGE_DIR, d))
        .filter((f) => f.endsWith(".json"))
        .map((f) => `${d}/${f}`),
    );
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk.sort());
    for (const [rel, sha] of Object.entries(manifest.files)) {
      const got = createHash("sha256")
        .update(readFileSync(join(EDGE_DIR, rel)))
        .digest("hex");
      expect({ rel, sha: got }).toEqual({ rel, sha });
    }
  });
});
