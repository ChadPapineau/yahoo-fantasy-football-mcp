// fixtures.ts — test helpers for the scoring suite: loads fixtures/golden/edge/** (plan 08 §8) and
// builds settings drafts from the sample league (research 03 §B.5) with patches.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleDraft, SettingsDraft } from "../../../src/domain/scoring/settings.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type {
  PositionType,
  ScoringBonus,
  ScoringSettings,
  StatLine,
} from "../../../src/domain/scoring/types.js";

export const EDGE_DIR = fileURLToPath(new URL("../../../fixtures/golden/edge/", import.meta.url));

/** A settings reference in a fixture: a base file name or a patch over one. */
export type SettingsRef =
  | string
  | {
      readonly base: string;
      readonly add_rules?: readonly RuleDraft[];
      readonly remove_platform_ids?: readonly string[];
      readonly modifiers?: Readonly<Record<string, number | null>>;
      readonly bonuses?: Readonly<Record<string, readonly ScoringBonus[]>>;
      readonly set?: Partial<
        Pick<
          SettingsDraft,
          "uses_negative_points" | "uses_fractional_points" | "rounding" | "negative_floor"
        >
      >;
      readonly reverse_rules?: boolean;
    };

/** The raw draft of a named base settings file. */
export function loadDraft(name: string): SettingsDraft {
  return JSON.parse(
    readFileSync(join(EDGE_DIR, "settings", `${name}.json`), "utf8"),
  ) as SettingsDraft;
}

/** Resolves a fixture settings reference to a draft (not yet normalised). */
export function draftOf(ref: SettingsRef): SettingsDraft {
  if (typeof ref === "string") return loadDraft(ref);
  const base = loadDraft(ref.base);
  let rules: RuleDraft[] = base.rules.map((r) => {
    const modifier = ref.modifiers?.[r.platform_id];
    const bonuses = ref.bonuses?.[r.platform_id];
    return {
      ...r,
      ...(modifier === undefined ? {} : { modifier }),
      ...(bonuses === undefined ? {} : { bonuses }),
    };
  });
  rules = rules.filter((r) => !(ref.remove_platform_ids ?? []).includes(r.platform_id));
  rules.push(...(ref.add_rules ?? []));
  if (ref.reverse_rules === true) rules.reverse();
  return { ...base, ...(ref.set ?? {}), rules };
}

/** The normalised sample league. */
export function sampleSettings(
  patch: Omit<Exclude<SettingsRef, string>, "base"> = {},
): ScoringSettings {
  return normalizeSettings(draftOf({ base: "sample-league", ...patch }));
}

/** A plain stat line (present derived from values). */
export function lineOf(
  position_type: PositionType,
  values: Readonly<Record<string, number>>,
  provisional = false,
): StatLine {
  return {
    values,
    present: Object.keys(values).sort(),
    position_type,
    provisional,
    source: "test",
  };
}

/** Every edge-case fixture file (name → parsed JSON). */
export function edgeCases(): { file: string; body: EdgeCase }[] {
  const dir = join(EDGE_DIR, "cases");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, body: JSON.parse(readFileSync(join(dir, file), "utf8")) as EdgeCase }));
}

export interface ExpectedScore {
  readonly points: number;
  readonly points_exact: number;
  readonly complete: boolean;
  readonly unmapped: readonly string[];
  readonly ignored: readonly string[];
  readonly contributions?: number;
  readonly contribution_points?: Readonly<Record<string, number>>;
  readonly negative_floor?: { readonly scope: string; readonly verified: boolean };
}

export interface EdgeCheck {
  readonly line?: {
    position_type: PositionType;
    provisional: boolean;
    values: Record<string, number>;
  };
  readonly nflverse_player?: Record<string, unknown>;
  readonly nflverse_defense?: { row: Record<string, unknown>; points_allowed: number | null };
  readonly made_list?: string;
  readonly expected?: ExpectedScore;
  readonly expected_compare?: ExpectedScore;
  readonly expected_error?: { code: string; detail: readonly string[] };
}

export interface EdgeCase {
  readonly name: string;
  readonly case: string;
  readonly source: string;
  readonly settings: SettingsRef;
  readonly settings_error?: { code: string; detail: readonly string[] };
  readonly compare?: { settings: SettingsRef; same_hash: boolean };
  readonly checks?: readonly EdgeCheck[];
}
