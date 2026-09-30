// projection.ts — the append-only `projection` table (plan 08 §5; plan 10 T12 never pruned; critic
// C-03: rows keyed subject + made_at so `getAsOf(before)` reads only pre-lock projections). Writes
// are best-effort (decision C-03b): a busy lock is a counted miss, never an error.
import { GSIS_ID_RE, isNflTeam, type NflTeam } from "../../config/schema.js";
import type { ProjectionRepository } from "../../domain/analytics/types.js";
import type { ProjectionSubject, StatLine, StoredProjection } from "../../domain/scoring/types.js";
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
  samples: parseJson<StatLine[]>(r.samples_json),
});

export function projectionRepository({ db, writes }: RepoDeps): ProjectionRepository {
  const newest = (extra: string) =>
    db.prepare(
      `SELECT * FROM projection WHERE subject_key = :subject AND season = :season AND week = :week
       AND model_version = :model ${extra} ORDER BY made_ms DESC LIMIT 1`,
    );
  return {
    put(p) {
      const key = subjectKey(p.subject);
      intIn(p.season, SEASON_MIN, SEASON_MAX, "season");
      intIn(p.week, 1, WEEK_MAX, "week");
      keyString(p.model_version, "model_version", 32);
      const madeMs = isoMs(p.made_at, "made_at");
      isoMs(p.inputs_as_of, "inputs_as_of");
      const expectation = JSON.stringify(p.expectation);
      const samples = JSON.stringify(p.samples);
      return writes.bestEffort(() => {
        // Append-only: the same (subject, season, week, model, made_at) twice keeps the first row.
        db.prepare(
          `INSERT OR IGNORE INTO projection
           (subject_key, season, week, model_version, made_at, made_ms, inputs_as_of, expectation_json, samples_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          key,
          p.season,
          p.week,
          p.model_version,
          p.made_at,
          madeMs,
          p.inputs_as_of,
          expectation,
          samples,
        );
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
