// league.ts — the league-side store tables (plan 01 §5.2): league_settings (never pruned, T5) with
// its settings flags (plan 03 §5 rows 19-20), roster / scoreboard / free-agent-pool snapshots (plan
// 06 §1.3; tension T11) and the append-only transactions_seen history. Every write here is REQUIRED
// (WRITE_CLASS): ≤ 1 s of yielding retries, then StoreBusyError.
import type {
  FaPoolSnapshot,
  FaPoolSnapshotRepository,
  LeagueSettingsRepository,
  LeagueSettingsRow,
  RosterSnapshot,
  RosterSnapshotRepository,
  ScoreboardSnapshot,
  ScoreboardSnapshotRepository,
  SettingsFlag,
  Transaction,
  TransactionsSeenRepository,
} from "../../domain/league/types.js";
import { immediate } from "../sqlite.js";
import { intIn, isoMs, keyString, parseJson, WEEK_MAX, type RepoDeps } from "./common.js";

const FLAG_KINDS: readonly string[] = [
  "scoring_mismatch",
  "scoring_mismatch_league",
  "settings_changed",
];
/** Fixed-vocabulary flag detail codes (never platform text). */
const DETAIL_CODE_RE = /^[a-z0-9_.:-]{1,64}$/;
/** Largest page `transactionsSeen.list` returns. */
export const TRANSACTIONS_LIST_MAX = 1000;

interface SettingsRow {
  league_key: string;
  settings_hash: string;
  scoring_json: string;
  slots_json: string;
  rules_json: string;
  fetched_at: string;
}

const toSettings = (r: SettingsRow): LeagueSettingsRow => ({
  league_key: r.league_key,
  settings_hash: r.settings_hash,
  scoring: parseJson(r.scoring_json),
  slots: parseJson(r.slots_json),
  rules: parseJson(r.rules_json),
  fetched_at: r.fetched_at,
});

export function leagueSettingsRepository({ db, writes }: RepoDeps): LeagueSettingsRepository {
  return {
    async put(row) {
      keyString(row.league_key, "league_key", 64);
      keyString(row.settings_hash, "settings_hash", 128);
      const ms = isoMs(row.fetched_at, "fetched_at");
      const scoring = JSON.stringify(row.scoring);
      const slots = JSON.stringify(row.slots);
      const rules = JSON.stringify(row.rules);
      await writes.required("league_settings", () => {
        // The hash identifies the content: a repeat put only advances fetched_at.
        db.prepare(
          `INSERT INTO league_settings (league_key, settings_hash, scoring_json, slots_json, rules_json, fetched_at, fetched_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (league_key, settings_hash) DO UPDATE SET fetched_at = excluded.fetched_at,
             fetched_ms = excluded.fetched_ms WHERE excluded.fetched_ms > league_settings.fetched_ms`,
        ).run(row.league_key, row.settings_hash, scoring, slots, rules, row.fetched_at, ms);
      });
    },

    byHash(settingsHash) {
      const r = db
        .prepare(
          "SELECT * FROM league_settings WHERE settings_hash = ? ORDER BY fetched_ms DESC LIMIT 1",
        )
        .get(settingsHash) as SettingsRow | undefined;
      return r === undefined ? null : toSettings(r);
    },

    latest(leagueKey) {
      const r = db
        .prepare(
          "SELECT * FROM league_settings WHERE league_key = ? ORDER BY fetched_ms DESC, rowid DESC LIMIT 1",
        )
        .get(leagueKey) as SettingsRow | undefined;
      return r === undefined ? null : toSettings(r);
    },

    async raiseFlag(flag: SettingsFlag) {
      keyString(flag.league_key, "league_key", 64);
      if (!FLAG_KINDS.includes(flag.kind))
        throw new RangeError("store: unknown settings flag kind");
      const raw: unknown = flag.detail;
      const detail: readonly unknown[] = Array.isArray(raw) ? raw : [null];
      if (
        detail.length > 64 ||
        !detail.every((d) => typeof d === "string" && DETAIL_CODE_RE.test(d))
      )
        throw new RangeError("store: flag detail must be fixed-vocabulary codes");
      isoMs(flag.raised_at, "raised_at");
      await writes.required("league_settings", () => {
        db.prepare(
          `INSERT INTO league_settings_flag (league_key, kind, detail_json, raised_at, acknowledged)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (league_key, kind) DO UPDATE SET detail_json = excluded.detail_json,
             raised_at = excluded.raised_at, acknowledged = excluded.acknowledged`,
        ).run(
          flag.league_key,
          flag.kind,
          JSON.stringify(flag.detail),
          flag.raised_at,
          flag.acknowledged ? 1 : 0,
        );
      });
    },

    openFlags(leagueKey) {
      const rows = db
        .prepare(
          "SELECT * FROM league_settings_flag WHERE league_key = ? AND acknowledged = 0 ORDER BY kind",
        )
        .all(leagueKey) as unknown as {
        league_key: string;
        kind: SettingsFlag["kind"];
        detail_json: string;
        raised_at: string;
      }[];
      return rows.map((r) => ({
        league_key: r.league_key,
        kind: r.kind,
        detail: parseJson<string[]>(r.detail_json),
        raised_at: r.raised_at,
        acknowledged: false,
      }));
    },
  };
}

export function rosterSnapshotRepository({ db, writes }: RepoDeps): RosterSnapshotRepository {
  return {
    async put(s: RosterSnapshot) {
      keyString(s.team_key, "team_key", 64);
      intIn(s.week, 1, WEEK_MAX, "week");
      const ms = isoMs(s.taken_at, "taken_at");
      const json = JSON.stringify(s.roster);
      await writes.required("roster_snapshot", () => {
        db.prepare(
          "INSERT INTO roster_snapshot (team_key, week, taken_at, taken_ms, roster_json) VALUES (?, ?, ?, ?, ?)",
        ).run(s.team_key, s.week, s.taken_at, ms, json);
      });
    },
    latestTwo(teamKey) {
      const rows = db
        .prepare(
          "SELECT * FROM roster_snapshot WHERE team_key = ? ORDER BY taken_ms DESC, id DESC LIMIT 2",
        )
        .all(teamKey) as unknown as {
        team_key: string;
        week: number;
        taken_at: string;
        roster_json: string;
      }[];
      return rows.map((r) => ({
        team_key: r.team_key,
        week: r.week,
        taken_at: r.taken_at,
        roster: parseJson(r.roster_json),
      }));
    },
  };
}

export function scoreboardSnapshotRepository({
  db,
  writes,
}: RepoDeps): ScoreboardSnapshotRepository {
  return {
    async put(s: ScoreboardSnapshot) {
      keyString(s.league_key, "league_key", 64);
      intIn(s.week, 1, WEEK_MAX, "week");
      const ms = isoMs(s.taken_at, "taken_at");
      if (typeof s.matchups_json !== "string")
        throw new RangeError("store: matchups_json must be a string");
      await writes.required("scoreboard_snapshot", () => {
        db.prepare(
          "INSERT INTO scoreboard_snapshot (league_key, week, taken_at, taken_ms, matchups_json) VALUES (?, ?, ?, ?, ?)",
        ).run(s.league_key, s.week, s.taken_at, ms, s.matchups_json);
      });
    },
    forWeek(leagueKey, week) {
      const rows = db
        .prepare(
          "SELECT league_key, week, taken_at, matchups_json FROM scoreboard_snapshot WHERE league_key = ? AND week = ? ORDER BY taken_ms, id",
        )
        .all(leagueKey, week) as unknown as ScoreboardSnapshot[];
      return rows.map((r) => ({
        league_key: r.league_key,
        week: r.week,
        taken_at: r.taken_at,
        matchups_json: r.matchups_json,
      }));
    },
  };
}

export function faPoolSnapshotRepository({ db, writes }: RepoDeps): FaPoolSnapshotRepository {
  return {
    async put(s: FaPoolSnapshot) {
      keyString(s.league_key, "league_key", 64);
      const ms = isoMs(s.taken_at, "taken_at");
      const json = JSON.stringify(s.players);
      await writes.required("fa_pool_snapshot", () => {
        db.prepare(
          "INSERT INTO fa_pool_snapshot (league_key, taken_at, taken_ms, players_json) VALUES (?, ?, ?, ?)",
        ).run(s.league_key, s.taken_at, ms, json);
      });
    },
    latestTwo(leagueKey) {
      const rows = db
        .prepare(
          "SELECT * FROM fa_pool_snapshot WHERE league_key = ? ORDER BY taken_ms DESC, id DESC LIMIT 2",
        )
        .all(leagueKey) as unknown as {
        league_key: string;
        taken_at: string;
        players_json: string;
      }[];
      return rows.map((r) => ({
        league_key: r.league_key,
        taken_at: r.taken_at,
        players: parseJson(r.players_json),
      }));
    },
  };
}

export function transactionsSeenRepository({ db, writes }: RepoDeps): TransactionsSeenRepository {
  return {
    async appendNew(leagueKey, txns, seenAt) {
      keyString(leagueKey, "league_key", 64);
      isoMs(seenAt, "seen_at");
      const rows = txns.map((t) => {
        keyString(t.transaction_key, "transaction_key", 64);
        return { t, ms: isoMs(t.timestamp, "timestamp"), json: JSON.stringify(t) };
      });
      if (rows.length === 0) return 0;
      return writes.required("transactions_seen", () =>
        immediate(db, () => {
          const ins = db.prepare(
            `INSERT OR IGNORE INTO transactions_seen (league_key, transaction_key, ts, ts_ms, seen_at, txn_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          let n = 0;
          for (const r of rows)
            n += Number(
              ins.run(leagueKey, r.t.transaction_key, r.t.timestamp, r.ms, seenAt, r.json).changes,
            );
          return n;
        }),
      );
    },
    list(leagueKey, since, limit) {
      const lim = intIn(limit, 1, TRANSACTIONS_LIST_MAX, "limit");
      const sinceMs = since === null ? null : isoMs(since, "since");
      const rows = db
        .prepare(
          `SELECT txn_json FROM transactions_seen WHERE league_key = :league
           AND (:since IS NULL OR ts_ms >= :since) ORDER BY ts_ms DESC, transaction_key DESC LIMIT :lim`,
        )
        .all({ league: leagueKey, since: sinceMs, lim }) as unknown as { txn_json: string }[];
      return rows.map((r) => parseJson<Transaction>(r.txn_json));
    },
    oldestSeen(leagueKey) {
      const r = db
        .prepare(
          "SELECT ts FROM transactions_seen WHERE league_key = ? ORDER BY ts_ms, transaction_key LIMIT 1",
        )
        .get(leagueKey) as { ts: string } | undefined;
      return r?.ts ?? null;
    },
  };
}
