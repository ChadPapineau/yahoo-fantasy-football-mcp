// derive.ts — the pure derivations the dataset contract names (tables.ts `derivation` fields): the
// kickoff instant from nflverse's Eastern wall-clock `gameday` + `gametime` (plan 01 §5.2 schedules
// row; research 04 §B1 "kickoff ET"), empty-string → NULL, roof normalisation, DATE → ISO date, and
// implied team totals from spread + total (nflverse dictionary: positive spread = home favoured).
// Shared by the sources that fill the tables and the store readers that read them; no I/O, no clock.

/** The zone nflverse `schedules.gametime` is written in (research 04 §B1 "gametime (ET)"). */
export const NFLVERSE_KICKOFF_TZ = "America/New_York";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (wall − UTC). Throws on a bad zone. */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock date + `HH:MM` in `timeZone` to a UTC ISO-8601 instant
 * (`YYYY-MM-DDTHH:MM:00.000Z`). Returns null for anything malformed (bad shape, month 13, Feb 30,
 * 24:00, non-string input) — never throws on data. An unknown zone is a programming error and throws.
 * A wall time inside a spring-forward gap resolves with the pre-transition offset (deterministic;
 * no NFL kickoff is scheduled at 02:xx).
 */
export function wallTimeToUtcIso(date: unknown, time: unknown, timeZone: string): string | null {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hh, mm] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mm > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, hh, mm);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  // Two-pass fixed point: the offset at the guessed instant, then at the corrected one.
  const off1 = zoneOffsetMs(timeZone, naive);
  let utc = naive - off1;
  const off2 = zoneOffsetMs(timeZone, utc);
  if (off2 !== off1) utc = naive - off2;
  return new Date(utc).toISOString();
}

/** `ds_games.kickoff_utc` from nflverse `gameday` + `gametime` (America/New_York). */
export function kickoffUtcFromEastern(gameday: unknown, gametime: unknown): string | null {
  return wallTimeToUtcIso(gameday, gametime, NFLVERSE_KICKOFF_TZ);
}

/**
 * Text normalisation applied to every stored TEXT column of the contract: null/undefined, a
 * non-string, or a string that is empty after trimming → null; otherwise the trimmed string.
 * (roster_weekly 2026 carries 16 `yahoo_id = ""` rows — an empty id must never match a lookup.)
 */
export function emptyToNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * `ds_games.roof`: nflverse writes `""` for retractable roofs whose state is not yet known (35 of
 * the 272 games of 2026, all future games at ATL/DAL/HOU/IND/ARI plus Madrid). `""` → null (the
 * reader then falls back to the venue's `roof_default`); anything else is trimmed + lower-cased.
 */
export function normalizeRoof(v: unknown): string | null {
  const t = emptyToNull(v);
  return t === null ? null : t.toLowerCase();
}

/**
 * A parquet DATE (hyparquet yields a `Date`; a string or day count is accepted defensively) → an
 * ISO calendar date `YYYY-MM-DD`, or null when absent/invalid.
 */
export function isoDate(v: unknown): string | null {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "string" && DATE_RE.test(v)) d = new Date(`${v}T00:00:00.000Z`);
  else if (typeof v === "number" && Number.isInteger(v)) d = new Date(v * 86_400_000);
  if (!d || Number.isNaN(d.getTime())) return null;
  const s = d.toISOString();
  if (s.length !== 24) return null;
  const out = s.slice(0, 10);
  // A string must round-trip: V8 rolls "2001-02-30" over to March 2 instead of rejecting it.
  return typeof v === "string" && out !== v ? null : out;
}

/** Implied team points from nflverse `spread_line` (+ = home favoured) and `total_line`. */
export interface ImpliedPoints {
  readonly away: number | null;
  readonly home: number | null;
}

/**
 * home = (total + spread) / 2, away = (total − spread) / 2 (research 05 §8 implied totals; the
 * nflverse dictionary: "a positive number means the home team was favored"). Both null when either
 * input is null or non-finite.
 */
export function impliedPoints(spreadLine: unknown, totalLine: unknown): ImpliedPoints {
  if (
    typeof spreadLine !== "number" ||
    typeof totalLine !== "number" ||
    !Number.isFinite(spreadLine) ||
    !Number.isFinite(totalLine)
  ) {
    return { away: null, home: null };
  }
  return { away: (totalLine - spreadLine) / 2, home: (totalLine + spreadLine) / 2 };
}
