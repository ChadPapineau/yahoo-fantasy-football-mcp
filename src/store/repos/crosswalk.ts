// crosswalk.ts — the persisted platform-player → gsis_id pairs (plan 01 §5.2 `crosswalk`, §5.5
// delta-only writes; research 04 §D; critic C-21 `last_seen` outside change detection, refreshed by
// a best-effort `touch` at LAST_SEEN_GRANULARITY_MS grain; critic C-04b required upsert).
import { GSIS_ID_RE } from "../../config/schema.js";
import {
  LAST_SEEN_GRANULARITY_MS,
  type CrosswalkPair,
  type CrosswalkRepository,
} from "../../domain/crosswalk/types.js";
import type { PlatformId } from "../../domain/league/types.js";
import { immediate } from "../sqlite.js";
import { isoMs, keyString, type RepoDeps } from "./common.js";

const PLATFORMS: readonly string[] = ["yahoo", "manual", "sleeper", "espn"];
const METHODS: readonly string[] = ["id", "match", "override"];
const SOURCES: readonly string[] = [
  "nflverse:roster_weekly",
  "dynastyprocess:ids",
  "sleeper:players",
  "platform",
  "overrides",
];
/** Most ids one `touch` call may name (bounded statement). */
export const TOUCH_MAX_IDS = 10_000;

function checkPlatform(p: unknown): PlatformId {
  if (typeof p !== "string" || !PLATFORMS.includes(p))
    throw new RangeError("store: unknown platform");
  return p as PlatformId;
}

function checkPair(p: CrosswalkPair): void {
  checkPlatform(p.platform);
  keyString(p.platform_player_id, "platform_player_id", 64);
  if (typeof p.gsis_id !== "string" || !GSIS_ID_RE.test(p.gsis_id))
    throw new RangeError("store: invalid gsis_id");
  if (!METHODS.includes(p.method)) throw new RangeError("store: invalid crosswalk method");
  if (!SOURCES.includes(p.source)) throw new RangeError("store: invalid crosswalk source");
  if (typeof p.confidence !== "number" || !(p.confidence >= 0 && p.confidence <= 1))
    throw new RangeError("store: confidence must be in 0..1");
  isoMs(p.first_seen, "first_seen");
  isoMs(p.last_seen, "last_seen");
}

interface Row {
  platform: string;
  platform_player_id: string;
  gsis_id: string;
  method: string;
  source: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
}

const toPair = (r: Row): CrosswalkPair => ({
  platform: r.platform as PlatformId,
  platform_player_id: r.platform_player_id,
  gsis_id: r.gsis_id,
  method: r.method as CrosswalkPair["method"],
  source: r.source as CrosswalkPair["source"],
  confidence: r.confidence,
  first_seen: r.first_seen,
  last_seen: r.last_seen,
});

const COLS =
  "platform, platform_player_id, gsis_id, method, source, confidence, first_seen, last_seen";

export function crosswalkRepository({ db, writes }: RepoDeps): CrosswalkRepository {
  return {
    get(platform, platformPlayerId) {
      const r = db
        .prepare(`SELECT ${COLS} FROM crosswalk WHERE platform = ? AND platform_player_id = ?`)
        .get(platform, platformPlayerId) as Row | undefined;
      return r === undefined ? null : toPair(r);
    },

    byGsis(gsisId) {
      return (
        db
          .prepare(
            `SELECT ${COLS} FROM crosswalk WHERE gsis_id = ? ORDER BY platform, platform_player_id`,
          )
          .all(gsisId) as unknown as Row[]
      ).map(toPair);
    },

    async upsertDelta(pairs) {
      for (const p of pairs) checkPair(p);
      if (pairs.length === 0) return 0;
      return writes.required("crosswalk", () =>
        immediate(db, () => {
          const sel = db.prepare(
            "SELECT gsis_id, method, source, confidence FROM crosswalk WHERE platform = ? AND platform_player_id = ?",
          );
          const ins = db.prepare(
            `INSERT INTO crosswalk (${COLS}, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const upd = db.prepare(
            `UPDATE crosswalk SET gsis_id = ?, method = ?, source = ?, confidence = ?, last_seen = ?, last_seen_ms = ?
             WHERE platform = ? AND platform_player_id = ?`,
          );
          let written = 0;
          for (const p of pairs) {
            const cur = sel.get(p.platform, p.platform_player_id) as
              { gsis_id: string; method: string; source: string; confidence: number } | undefined;
            const ms = isoMs(p.last_seen, "last_seen");
            if (cur === undefined) {
              ins.run(
                p.platform,
                p.platform_player_id,
                p.gsis_id,
                p.method,
                p.source,
                p.confidence,
                p.first_seen,
                p.last_seen,
                ms,
              );
              written += 1;
            } else if (
              cur.gsis_id !== p.gsis_id ||
              cur.method !== p.method ||
              cur.source !== p.source ||
              cur.confidence !== p.confidence
            ) {
              upd.run(
                p.gsis_id,
                p.method,
                p.source,
                p.confidence,
                p.last_seen,
                ms,
                p.platform,
                p.platform_player_id,
              );
              written += 1;
            }
          }
          return written;
        }),
      );
    },

    touch(platform, platformPlayerIds, at) {
      checkPlatform(platform);
      const atMs = isoMs(at, "at");
      if (platformPlayerIds.length > TOUCH_MAX_IDS)
        throw new RangeError(`store: touch takes at most ${String(TOUCH_MAX_IDS)} ids`);
      if (platformPlayerIds.length === 0) return { written: true };
      const ids = JSON.stringify(platformPlayerIds.filter((s) => typeof s === "string"));
      return writes.bestEffort(() => {
        db.prepare(
          `UPDATE crosswalk SET last_seen = :at, last_seen_ms = :at_ms
           WHERE platform = :platform AND platform_player_id IN (SELECT value FROM json_each(:ids))
             AND last_seen_ms < :threshold`,
        ).run({ at, at_ms: atMs, platform, ids, threshold: atMs - LAST_SEEN_GRANULARITY_MS });
      });
    },

    count(platform) {
      return (
        db.prepare("SELECT COUNT(*) AS n FROM crosswalk WHERE platform = ?").get(platform) as {
          n: number;
        }
      ).n;
    },
  };
}
