// caches.ts — the best-effort store tables (plan 01 §5.3 OBJ-11): points_cache, yahoo_cache
// (Phase 1b platform responses; prunable) and limiter_state. Every write waits at most the 100 ms
// busy_timeout once; a busy lock is a counted miss (`cache_misses_busy`), never an error.
import { GSIS_ID_RE } from "../../config/schema.js";
import type { IsoInstant } from "../../domain/league/types.js";
import type {
  LimiterStateRepository,
  PlatformCacheEntry,
  PlatformCacheRepository,
  PointsCacheRepository,
} from "../types.js";
import {
  finite,
  intIn,
  isoMs,
  keyString,
  SEASON_MAX,
  SEASON_MIN,
  WEEK_MAX,
  type RepoDeps,
} from "./common.js";

export function pointsCacheRepository({ db, writes }: RepoDeps): PointsCacheRepository {
  return {
    get(settingsHash, gsisId, season, week) {
      const r = db
        .prepare(
          "SELECT points FROM points_cache WHERE settings_hash = ? AND gsis_id = ? AND season = ? AND week = ?",
        )
        .get(settingsHash, gsisId, season, week) as { points: number } | undefined;
      return r?.points ?? null;
    },
    put(settingsHash, gsisId, season, week, points) {
      keyString(settingsHash, "settings_hash", 128);
      if (!GSIS_ID_RE.test(gsisId)) throw new RangeError("store: invalid gsis_id");
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      intIn(week, 1, WEEK_MAX, "week");
      finite(points, "points");
      return writes.bestEffort(() => {
        db.prepare(
          "INSERT OR REPLACE INTO points_cache (settings_hash, gsis_id, season, week, points) VALUES (?, ?, ?, ?, ?)",
        ).run(settingsHash, gsisId, season, week, points);
      });
    },
  };
}

/** Largest cached platform body (a Yahoo page is ~20 KB; a hostile 100 MB body is refused). */
export const PLATFORM_CACHE_MAX_BODY = 4 * 1024 * 1024;

export function platformCacheRepository({ db, writes }: RepoDeps): PlatformCacheRepository {
  return {
    get(key) {
      const r = db
        .prepare(
          "SELECT key, body, parsed_json, fetched_at, refresh_rate_s, http_status FROM yahoo_cache WHERE key = ?",
        )
        .get(key) as PlatformCacheEntry | undefined;
      return r === undefined
        ? null
        : {
            key: r.key,
            body: r.body,
            parsed_json: r.parsed_json,
            fetched_at: r.fetched_at,
            refresh_rate_s: r.refresh_rate_s,
            http_status: r.http_status,
          };
    },
    put(e) {
      keyString(e.key, "key", 2048);
      const ms = isoMs(e.fetched_at, "fetched_at");
      if (typeof e.body !== "string" || e.body.length > PLATFORM_CACHE_MAX_BODY)
        throw new RangeError("store: cache body too large");
      if (
        e.parsed_json !== null &&
        (typeof e.parsed_json !== "string" || e.parsed_json.length > PLATFORM_CACHE_MAX_BODY)
      )
        throw new RangeError("store: cache parsed_json too large");
      if (e.refresh_rate_s !== null) intIn(e.refresh_rate_s, 0, 86_400 * 365, "refresh_rate_s");
      intIn(e.http_status, 100, 599, "http_status");
      return writes.bestEffort(() => {
        db.prepare(
          `INSERT OR REPLACE INTO yahoo_cache (key, body, parsed_json, fetched_at, fetched_ms, refresh_rate_s, http_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(e.key, e.body, e.parsed_json, e.fetched_at, ms, e.refresh_rate_s, e.http_status);
      });
    },
    prune(before: IsoInstant) {
      const ms = isoMs(before, "before");
      // Maintenance (`store prune`, plan 06 §1.2): a busy lock prunes nothing (and counts a miss).
      let n = 0;
      writes.bestEffort(() => {
        n = Number(db.prepare("DELETE FROM yahoo_cache WHERE fetched_ms < ?").run(ms).changes);
      });
      return n;
    },
  };
}

export function limiterStateRepository({ db, writes }: RepoDeps): LimiterStateRepository {
  return {
    last999(clientKey) {
      const r = db
        .prepare("SELECT last999 FROM limiter_state WHERE client_key = ?")
        .get(clientKey) as { last999: string } | undefined;
      return r?.last999 ?? null;
    },
    setLast999(clientKey, at) {
      keyString(clientKey, "client_key", 128);
      isoMs(at, "at");
      return writes.bestEffort(() => {
        db.prepare("INSERT OR REPLACE INTO limiter_state (client_key, last999) VALUES (?, ?)").run(
          clientKey,
          at,
        );
      });
    },
  };
}
