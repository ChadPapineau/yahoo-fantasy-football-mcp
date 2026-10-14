// fixture.ts — the committed nflverse schedules excerpt (every 2025 and 2026 game, fixtures/nflverse)
// as NflGame rows with `game_type` and `gameday`, the way the store reader fills them. Used by the
// calendar tests to check the real 2025/2026 calendars (Wednesday, Friday, Saturday and Christmas
// games; the 2026 Week-18 placeholder) next to the synthetic seasons.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parquetReadObjects } from "hyparquet";
import { isNflTeam } from "../../../src/config/schema.js";
import type { NflGame } from "../../../src/domain/analytics/types.js";
import { kickoffUtcFromEastern, normalizeRoof } from "../../../src/store/datasets/derive.js";

const FILE = fileURLToPath(
  new URL("../../../fixtures/nflverse/schedules/games.excerpt.parquet", import.meta.url),
);

type Row = Readonly<Record<string, unknown>>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

let cached: Promise<readonly NflGame[]> | null = null;

/** Every fixture game (2025 and 2026), loaded once per process. */
export function loadFixtureGames(): Promise<readonly NflGame[]> {
  cached ??= (async () => {
    const buf = readFileSync(FILE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const rows = (await parquetReadObjects({ file: ab })) as Row[];
    const out: NflGame[] = [];
    for (const r of rows) {
      const away = str(r.away_team);
      const home = str(r.home_team);
      if (away === null || home === null || !isNflTeam(away) || !isNflTeam(home)) continue;
      out.push({
        game_id: String(r.game_id),
        season: Number(r.season),
        week: Number(r.week),
        kickoff: kickoffUtcFromEastern(r.gameday, r.gametime),
        away,
        home,
        stadium_id: str(r.stadium_id),
        stadium: null,
        venue_tz: null,
        roof: normalizeRoof(r.roof),
        surface: null,
        divisional: null,
        rest_days: { away: null, home: null },
        lines: null,
        is_final: false,
        score: null,
        game_type: str(r.game_type),
        gameday: str(r.gameday),
      });
    }
    return Object.freeze(out);
  })();
  return cached;
}
