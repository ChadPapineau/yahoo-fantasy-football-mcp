// helpers.ts — a real 0700 config dir with a 0600 league.yaml for the ManualLeagueProvider tests
// (the path rules are about real modes and symlinks, so they run against real temp files — never
// the user's ~/.config), plus stub dataset readers and a fixed clock.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NflGame, ScheduleReader } from "../../../src/domain/analytics/types.js";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import type { NflRosterPlayer, RosterWeeklyReader } from "../../../src/domain/crosswalk/types.js";
import {
  ManualLeagueProvider,
  type ManualLeagueProviderOptions,
} from "../../../src/providers/manual/index.js";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The placeholder fixture league. */
export const FIXTURE_FILE = path.join(ROOT, "fixtures", "manual", "league.yaml");
/** Its text. */
export const FIXTURE_TEXT = readFileSync(FIXTURE_FILE, "utf8");

/** A temp config dir (0700) holding league.yaml (0600) with `text`. */
export interface TempLeague {
  readonly root: string;
  readonly dir: string;
  readonly file: string;
  write(text: string, mode?: number): void;
  cleanup(): void;
}

export function tempLeague(text: string = FIXTURE_TEXT): TempLeague {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-manual-")));
  chmodSync(root, 0o700);
  const dir = path.join(root, "config");
  mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "league.yaml");
  const write = (t: string, mode = 0o600): void => {
    writeFileSync(file, t, { mode });
    chmodSync(file, mode);
  };
  write(text);
  return {
    root,
    dir,
    file,
    write,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The Clock the tests use: Wednesday 2026-09-30 12:00 UTC unless told otherwise. */
export function clock(at = "2026-09-30T12:00:00.000Z"): FixedClock {
  return fixedClock(at);
}

/** A ScheduleReader over a fixed list of games. */
export function scheduleOf(games: readonly NflGame[]): ScheduleReader {
  return {
    games: (season, weeks) => ({
      rows: games.filter((g) => g.season === season && weeks.includes(g.week)),
      stamp: null,
    }),
    firstKickoff: () => null,
  };
}

/** A RosterWeeklyReader over fixed rows. */
export function rostersOf(rows: readonly NflRosterPlayer[]): RosterWeeklyReader {
  return {
    latest: (season) => ({ rows: rows.filter((r) => r.season === season), stamp: null }),
    byPlatformId: () => ({ rows: [], stamp: null }),
  };
}

/** A provider over `file` (fixture mode off unless `requirePrivate: false`). */
export function provider(
  file: string,
  opts: Partial<Omit<ManualLeagueProviderOptions, "file">> = {},
): ManualLeagueProvider {
  return new ManualLeagueProvider({ file, clock: opts.clock ?? clock(), ...opts });
}

/** Replaces the first occurrence of `from` in the fixture text (throws when absent). */
export function edit(from: string, to: string, text: string = FIXTURE_TEXT): string {
  if (!text.includes(from)) throw new Error(`fixture edit: ${from} not found`);
  return text.replace(from, to);
}
