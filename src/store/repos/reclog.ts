// reclog.ts — recommendation_log + recommendation_outcome (plan 01 §8.2 never pruned; plan 07
// E12/E14; critic C-02b outcome beside the immutable row; REQUIRED writes → StoreBusyError after
// ≤ 1 s). Free text in a stored record is model-authored and untrusted on read (OBJ-15): the store
// returns it raw; the tools path-list RECLOG_TEXT_PATHS.
import { randomBytes } from "node:crypto";
import type { PageOf } from "../../domain/league/types.js";
import {
  LOG_ID_RE,
  RECOMMENDATION_KINDS,
  RECORD_DEDUP_SCOPE,
  recordDedupParams,
  recordDedupScope,
  type RecommendationListItem,
  type RecommendationLogRepository,
  type RecommendationOutcome,
  type RecommendationQuery,
  type RecommendationRecord,
  type RecordRecommendationInput,
  type RecordResult,
} from "../../domain/reclog/types.js";
import { immediate } from "../sqlite.js";
import {
  bitOrNull,
  boolOrNull,
  intIn,
  isoMs,
  keyString,
  parseJson,
  SEASON_MAX,
  SEASON_MIN,
  WEEK_MAX,
  type RepoDeps,
} from "./common.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A `rec-` + ULID log id: 48-bit time from `ms`, 80 random bits (LOG_ID_RE). */
export function newLogId(ms: number): string {
  let t = Math.max(0, Math.min(Math.floor(ms), 2 ** 48 - 1));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[t % 32] ?? "0") + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(rnd[i] ?? 0) & 31] ?? "0";
  return `rec-${time}${rand}`;
}

/** Page bounds (plan 01 §4.2): limit 1..100, offset 0..10 000. */
const LIMIT_MAX = 100;
const OFFSET_MAX = 10_000;

interface LogRow {
  log_id: string;
  kind: string;
  season: number;
  week: number;
  recorded_at: string;
  settings_hash: string | null;
  record_json: string;
  followed?: number | null;
}

function validate(input: RecordRecommendationInput): void {
  keyString(input.league_key, "league_key", 64);
  intIn(input.season, SEASON_MIN, SEASON_MAX, "season");
  intIn(input.week, 1, WEEK_MAX, "week");
  if (!(RECOMMENDATION_KINDS as readonly string[]).includes(input.kind))
    throw new RangeError("store: unknown recommendation kind");
  if (input.client_ref !== null) keyString(input.client_ref, "client_ref", 64);
  if (input.note !== null && (typeof input.note !== "string" || input.note.length > 200))
    throw new RangeError("store: note must be at most 200 chars");
}

function toRecord(r: LogRow): RecommendationRecord {
  const input = parseJson<RecordRecommendationInput>(r.record_json);
  return { ...input, log_id: r.log_id, recorded_at: r.recorded_at, settings_hash: r.settings_hash };
}

export function recommendationLogRepository({ db, writes }: RepoDeps): RecommendationLogRepository {
  return {
    async record(input, recordedAt, settingsHash): Promise<RecordResult> {
      validate(input);
      const ms = isoMs(recordedAt, "recorded_at");
      if (settingsHash !== null) keyString(settingsHash, "settings_hash", 128);
      const json = JSON.stringify(input);
      return writes.required("recommendation_log", () =>
        immediate(db, () => {
          // the dedup scope is league + season + week + kind + client_ref, never the key alone (QA-1-061)
          const scope = recordDedupScope(input);
          if (scope !== null) {
            const prior = db
              .prepare(
                `SELECT log_id, recorded_at, week, kind FROM recommendation_log WHERE ${RECORD_DEDUP_SCOPE.map((c) => `${c} = ?`).join(" AND ")}`,
              )
              .get(...recordDedupParams(scope)) as
              { log_id: string; recorded_at: string; week: number; kind: string } | undefined;
            if (prior !== undefined)
              return {
                log_id: prior.log_id,
                recorded_at: prior.recorded_at,
                week: prior.week,
                kind: prior.kind as RecordResult["kind"],
                deduplicated: true,
              };
          }
          const logId = newLogId(ms);
          db.prepare(
            `INSERT INTO recommendation_log
             (log_id, league_key, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            logId,
            input.league_key,
            input.season,
            input.week,
            input.kind,
            recordedAt,
            ms,
            settingsHash,
            input.client_ref,
            json,
          );
          return {
            log_id: logId,
            recorded_at: recordedAt,
            week: input.week,
            kind: input.kind,
            deduplicated: false,
          };
        }),
      );
    },

    get(logId) {
      if (typeof logId !== "string" || !LOG_ID_RE.test(logId)) return null;
      const r = db.prepare("SELECT * FROM recommendation_log WHERE log_id = ?").get(logId) as
        LogRow | undefined;
      return r === undefined ? null : toRecord(r);
    },

    list(q: RecommendationQuery): PageOf<RecommendationListItem> {
      keyString(q.league_key, "league_key", 64);
      const limit = intIn(q.limit, 1, LIMIT_MAX, "limit");
      const offset = intIn(q.offset, 0, OFFSET_MAX, "offset");
      if (q.season !== null) intIn(q.season, SEASON_MIN, SEASON_MAX, "season");
      if (q.week !== null) intIn(q.week, 1, WEEK_MAX, "week");
      const where = `l.league_key = :league
        AND (:season IS NULL OR l.season = :season)
        AND (:week IS NULL OR l.week = :week)
        AND (:kind IS NULL OR l.kind = :kind)`;
      const params = { league: q.league_key, season: q.season, week: q.week, kind: q.kind };
      const total = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM recommendation_log AS l WHERE ${where}`)
          .get(params) as {
          n: number;
        }
      ).n;
      const rows = db
        .prepare(
          `SELECT l.*, o.followed AS followed FROM recommendation_log AS l
           LEFT JOIN recommendation_outcome AS o ON o.log_id = l.log_id
           WHERE ${where} ORDER BY l.recorded_ms DESC, l.log_id DESC LIMIT :limit OFFSET :offset`,
        )
        .all({ ...params, limit, offset }) as unknown as LogRow[];
      const items = rows.map((r): RecommendationListItem => {
        const rec = toRecord(r);
        return {
          log_id: r.log_id,
          kind: rec.kind,
          season: r.season,
          week: r.week,
          recorded_at: r.recorded_at,
          action_summary: rec.rec.action,
          followed: boolOrNull(r.followed),
        };
      });
      const hasMore = offset + items.length < total;
      return {
        items,
        limit,
        offset,
        count: items.length,
        has_more: hasMore,
        next_offset: hasMore ? offset + items.length : null,
        total,
      };
    },

    forWeek(leagueKey, season, week) {
      const rows = db
        .prepare(
          "SELECT * FROM recommendation_log WHERE league_key = ? AND season = ? AND week = ? ORDER BY recorded_ms, log_id",
        )
        .all(leagueKey, season, week) as unknown as LogRow[];
      return rows.map(toRecord);
    },

    async recordOutcome(o: RecommendationOutcome): Promise<void> {
      if (!LOG_ID_RE.test(o.log_id)) throw new RangeError("store: invalid log_id");
      isoMs(o.scored_at, "scored_at");
      for (const [k, v] of [
        ["realised", o.realised],
        ["regret", o.regret],
      ] as const)
        if (v !== null && !Number.isFinite(v)) throw new RangeError(`store: ${k} must be finite`);
      await writes.required("recommendation_outcome", () => {
        // A final outcome is immutable; a provisional one is re-written (critic C-02b).
        db.prepare(
          `INSERT INTO recommendation_outcome (log_id, followed, realised, regret, decisive, scored_at, week_final)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (log_id) DO UPDATE SET followed = excluded.followed, realised = excluded.realised,
             regret = excluded.regret, decisive = excluded.decisive, scored_at = excluded.scored_at,
             week_final = excluded.week_final
           WHERE recommendation_outcome.week_final = 0`,
        ).run(
          o.log_id,
          bitOrNull(o.followed),
          o.realised,
          o.regret,
          bitOrNull(o.decisive),
          o.scored_at,
          o.week_final ? 1 : 0,
        );
      });
    },

    outcome(logId) {
      if (typeof logId !== "string" || !LOG_ID_RE.test(logId)) return null;
      const r = db.prepare("SELECT * FROM recommendation_outcome WHERE log_id = ?").get(logId) as
        | {
            log_id: string;
            followed: number | null;
            realised: number | null;
            regret: number | null;
            decisive: number | null;
            scored_at: string;
            week_final: number;
          }
        | undefined;
      if (r === undefined) return null;
      return {
        log_id: r.log_id,
        followed: boolOrNull(r.followed),
        realised: r.realised,
        regret: r.regret,
        decisive: boolOrNull(r.decisive),
        scored_at: r.scored_at,
        week_final: r.week_final === 1,
      };
    },
  };
}
