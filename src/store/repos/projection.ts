// projection.ts — the append-only `projection` table (plan 08 §5; plan 10 T12 never pruned; critic
// C-03: rows keyed subject + made_at so `getAsOf(before)` reads only pre-lock projections). Writes
// are best-effort (decision C-03b): a busy lock is a counted miss, never an error. Samples are stored
// in the compressed form of ./samples-codec.ts (plan 08 §5 "compressed"; A15 latency).
// Growth is bounded by what the retrospective can use, not by call count (QA-1-031/QA-1-081): a run
// whose RECORDED inputs — inputs_as_of and expectation — equal those of the newest earlier row of
// the same (subject, season, week, model_version) adds no row. getAsOf(before) then answers with
// that earlier row: a projection made from exactly the inputs the collapsed run recorded, before
// `before`, so a pre-lock read is unchanged (only a later run with NEW inputs can supersede it).
import { GSIS_ID_RE, isNflTeam, type NflTeam } from "../../config/schema.js";
import type { ProjectionRepository } from "../../domain/analytics/types.js";
import type { ProjectionSubject, StoredProjection } from "../../domain/scoring/types.js";
import {
  intIn,
  isoMs,
  keyString,
  parseJson,
  SEASON_MAX,
  SEASON_MIN,
  WEEK_MAX,
  type RepoDeps,
} from "./common.js";
import { decodeSamples, encodeSamples } from "./samples-codec.js";

/** The stored key of a subject: `p:<gsis_id>` or `d:<TEAM>`; RangeError on an invalid subject. */
export function subjectKey(s: ProjectionSubject): string {
  if (s.kind === "player") {
    if (!GSIS_ID_RE.test(s.gsis_id)) throw new RangeError("store: invalid gsis_id");
    return `p:${s.gsis_id}`;
  }
  if (!isNflTeam(s.nfl_team)) throw new RangeError("store: invalid nfl_team");
  return `d:${s.nfl_team}`;
}

function subjectOf(key: string): ProjectionSubject {
  return key.startsWith("p:")
    ? { kind: "player", gsis_id: key.slice(2) }
    : { kind: "defense", nfl_team: key.slice(2) as NflTeam };
}

interface Row {
  subject_key: string;
  season: number;
  week: number;
  model_version: string;
  made_at: string;
  inputs_as_of: string;
  expectation_json: string;
  samples_json: string;
}

const toStored = (r: Row): StoredProjection => ({
  subject: subjectOf(r.subject_key),
  season: r.season,
  week: r.week,
  model_version: r.model_version,
  made_at: r.made_at,
  inputs_as_of: r.inputs_as_of,
  expectation: parseJson<Record<string, number>>(r.expectation_json),
  samples: decodeSamples(r.samples_json),
});

/**
 * Matches when the newest row of the key made at or before `:made` recorded the same inputs_as_of
 * and expectation (QA-1-031). Only that ONE row is compared, so A, B, A again appends the second A.
 */
const REPEATS_PREVIOUS_SQL = `SELECT 1 FROM (
    SELECT inputs_as_of, expectation_json FROM projection
    WHERE subject_key = :subject AND season = :season AND week = :week AND model_version = :model
      AND made_ms <= :made
    ORDER BY made_ms DESC LIMIT 1
  ) AS prev WHERE prev.inputs_as_of = :inputs AND prev.expectation_json = :expectation`;

export function projectionRepository({ db, writes }: RepoDeps): ProjectionRepository {
  const newest = (extra: string) =>
    db.prepare(
      `SELECT * FROM projection WHERE subject_key = :subject AND season = :season AND week = :week
       AND model_version = :model ${extra} ORDER BY made_ms DESC LIMIT 1`,
    );
  const repeatsPrevious = db.prepare(REPEATS_PREVIOUS_SQL);
  return {
    put(p) {
      const key = subjectKey(p.subject);
      intIn(p.season, SEASON_MIN, SEASON_MAX, "season");
      intIn(p.week, 1, WEEK_MAX, "week");
      keyString(p.model_version, "model_version", 32);
      const madeMs = isoMs(p.made_at, "made_at");
      isoMs(p.inputs_as_of, "inputs_as_of");
      const expectation = JSON.stringify(p.expectation);
      const sameAs = {
        subject: key,
        season: p.season,
        week: p.week,
        model: p.model_version,
        made: madeMs,
        inputs: p.inputs_as_of,
        expectation,
      };
      // A repeat of the newest earlier run's recorded inputs is already stored: no encode, no write.
      if (repeatsPrevious.get(sameAs) !== undefined) return { written: true };
      const samples = encodeSamples(p.samples);
      return writes.bestEffort(() => {
        // Append-only: the same (subject, season, week, model, made_at) twice keeps the first row;
        // the NOT EXISTS re-checks the repeat inside the write (one autocommit statement).
        db.prepare(
          `INSERT OR IGNORE INTO projection
           (subject_key, season, week, model_version, made_at, made_ms, inputs_as_of, expectation_json, samples_json)
           SELECT :subject, :season, :week, :model, :made_at, :made, :inputs, :expectation, :samples
           WHERE NOT EXISTS (${REPEATS_PREVIOUS_SQL})`,
        ).run({ ...sameAs, made_at: p.made_at, samples });
      });
    },

    latest(subject, season, week, modelVersion) {
      const r = newest("").get({
        subject: subjectKey(subject),
        season,
        week,
        model: modelVersion,
      }) as Row | undefined;
      return r === undefined ? null : toStored(r);
    },

    getAsOf(subject, season, week, modelVersion, before) {
      const r = newest("AND made_ms < :before").get({
        subject: subjectKey(subject),
        season,
        week,
        model: modelVersion,
        before: isoMs(before, "before"),
      }) as Row | undefined;
      return r === undefined ? null : toStored(r);
    },
  };
}
