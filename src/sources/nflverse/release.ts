// release.ts — nflverse release access (plan 01 §5.5 "reads timestamp.txt … downloads to a temp
// file"; research 04 §B1: `https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}`,
// 24-byte `timestamp.txt` per tag). Versions come from timestamp.txt; files are fetched through the
// runner's injected HttpGet / HttpDownload (never global fetch) into the run's temp directory.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IsoInstant } from "../../domain/league/types.js";
import { HttpError, isTransientNetworkError } from "../../http/errors.js";
import type { HttpGet, ReleaseVersion, SourceContext, TempFile } from "../source.js";

/** Where every nflverse release asset lives. */
export const NFLVERSE_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

/** The release tags the Phase-1a sources read. */
export type NflverseTag = "schedules" | "injuries" | "weekly_rosters" | "stats_player";

/** timestamp.txt is 24 bytes today; anything beyond this is not a timestamp. */
export const TIMESTAMP_MAX_BYTES = 256;
/** Cap per release file (the 2026 files are 29 KB–740 KB; plan 01 §5.6 "< 5 MB each"). */
export const MAX_RELEASE_FILE_BYTES = 16 * 1024 * 1024;
/** The oldest and newest season a URL may be built for (nflverse starts in 1999). */
export const MIN_SEASON = 1999;
export const MAX_SEASON = 2100;

/**
 * How long after a season's first kickoff a per-season file may still be missing upstream before a
 * 404 for it is a real failure (QA-1-033). nflverse builds a season's stats after its first games
 * and its injury reports from the first practice report; two weeks covers both with margin.
 */
export const SEASON_PUBLISH_GRACE_DAYS = 14;

/**
 * The NFL season in progress at `nowMs`: the calendar year from September (UTC), the previous year
 * through August — the same rule `ff refresh` picks its default seasons by.
 */
export function nflSeasonAt(nowMs: number): number {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 8 ? y : y - 1;
}

/** Whether `err` is upstream answering 404 for the URL (thrown by src/http, or a returned status). */
export function isNotFound(err: unknown): boolean {
  if (err instanceof HttpError) return err.kind === "http_4xx" && err.status === 404;
  return err instanceof NflverseSourceError && err.status === 404;
}

/**
 * Whether a 404 for `season`'s file can mean "not published yet" rather than a real failure: the
 * season is the current one (or later) and has not been under way for SEASON_PUBLISH_GRACE_DAYS
 * (its week-1 first kickoff, when schedules know it). A past season's file always exists.
 */
export function mayBeUnpublished(season: number, ctx: SourceContext): boolean {
  const now = ctx.clock.nowMs();
  if (season < nflSeasonAt(now)) return false;
  let kickoff: string | null = null;
  try {
    kickoff = ctx.datasets.schedules.firstKickoff(season, 1);
  } catch {
    kickoff = null;
  }
  const k = kickoff === null ? Number.NaN : Date.parse(kickoff);
  return !Number.isFinite(k) || now < k + SEASON_PUBLISH_GRACE_DAYS * 86_400_000;
}

/** An nflverse source failed in a way the run must report (never retried silently). */
export class NflverseSourceError extends Error {
  readonly code: "bad_timestamp" | "bad_season" | "download" | "not_parquet" | "schema";
  /** The HTTP status of a non-200 download answered by a status-returning transport, else null. */
  readonly status: number | null;
  constructor(code: NflverseSourceError["code"], message: string, status: number | null = null) {
    super(message);
    this.name = "NflverseSourceError";
    this.code = code;
    this.status = status;
  }
}

/** The URL of a release asset; `file` must be a plain file name. */
export function releaseUrl(tag: NflverseTag, file: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(file) || file.includes("..")) {
    throw new NflverseSourceError(
      "download",
      `nflverse: refusing file name ${JSON.stringify(file)}`,
    );
  }
  return `${NFLVERSE_RELEASE_BASE}/${tag}/${file}`;
}

/** A season number fit for a URL; anything else throws (seasons come from config, not upstream). */
export function assertSeason(season: unknown): number {
  if (
    typeof season !== "number" ||
    !Number.isInteger(season) ||
    season < MIN_SEASON ||
    season > MAX_SEASON
  ) {
    throw new NflverseSourceError(
      "bad_season",
      `nflverse: season must be an integer ${String(MIN_SEASON)}–${String(MAX_SEASON)}`,
    );
  }
  return season;
}

/** The seasons of a run, validated, de-duplicated, in the caller's order. */
export function runSeasons(seasons: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (const s of seasons) if (!out.includes(assertSeason(s))) out.push(s);
  return out;
}

const ZONE_OFFSET_MIN: Readonly<Record<string, number>> = Object.freeze({
  EDT: -240,
  EST: -300,
  UTC: 0,
  GMT: 0,
  Z: 0,
});

const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\s*(EDT|EST|UTC|GMT|Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses nflverse's `timestamp.txt` (`2026-09-30 09:36:26 EDT` — a US Eastern wall time with its
 * zone abbreviation; the parquet key-value `nflverse_timestamp` has the same form) or an ISO-8601
 * instant into an ISO-8601 UTC instant. Unknown zone abbreviations, impossible dates and anything
 * else return null — a zone is never guessed.
 */
export function parseNflverseTimestamp(text: unknown): IsoInstant | null {
  if (typeof text !== "string" || text.length > TIMESTAMP_MAX_BYTES) return null;
  const m = TS_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  const zone = m[7] ?? "";
  let offsetMin = ZONE_OFFSET_MIN[zone];
  if (offsetMin === undefined) {
    // TS_RE admits only the named zones or ±HH[:]MM here.
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.replace(/[^0-9]/g, "");
    const hh = Number(digits.slice(0, 2));
    const mm = Number(digits.slice(2));
    if (hh > 14 || mm > 59) return null;
    offsetMin = sign * (hh * 60 + mm);
  }
  return new Date(naive - offsetMin * 60_000).toISOString();
}

/**
 * The version string for a release instant and a run's seasons: `YYYYMMDDTHHMMSSZ_<s1>-<s2>…` —
 * filename-safe (the staging file is `<stem>.<version>.<rand>.tmp`), and it changes when the
 * seasons asked for change, so a run covering a different season set is never skipped as
 * "unchanged" against a file that does not hold those seasons.
 */
export function versionString(releasedAt: IsoInstant, seasons: readonly number[]): string {
  const compact = releasedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${compact}_${seasons.join("-")}`;
}

/** The runner's optional additions to SourceContext (src/sources/source.ts, added by src/http). */
interface ContextExtras {
  readonly tempDir?: string;
  readonly download?: (
    url: string,
    opts: {
      readonly signal: AbortSignal;
      readonly maxBytes: number;
      readonly dest: string;
      readonly accept?: string;
    },
  ) => Promise<{ readonly status: number; readonly bytes: number; readonly final_url: string }>;
}

async function httpGetOrNull(
  http: HttpGet,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    const res = await http(url, { signal, maxBytes: TIMESTAMP_MAX_BYTES, accept: "text/plain" });
    if (res.status !== 200 || res.body.length > TIMESTAMP_MAX_BYTES) return null;
    return res.body;
  } catch (err) {
    // a transient failure (DNS, reset, timeout, 5xx, 429) is re-thrown so the runner retries it
    // (plan 01 §6, max 3 attempts); anything else reads as "unreachable" (null)
    if (signal.aborted || isTransientNetworkError(err)) throw err;
    return null;
  }
}

/**
 * Reads `{tag}/timestamp.txt` and returns the release version for the run's seasons, or null when
 * upstream is unreachable / answers non-200 (DataSource.version contract). A reachable but
 * unparseable timestamp throws `bad_timestamp` — a format change must fail loudly, not look like
 * an outage.
 */
export async function releaseVersion(
  tag: NflverseTag,
  ctx: SourceContext,
): Promise<ReleaseVersion | null> {
  const seasons = runSeasons(ctx.seasons);
  const body = await httpGetOrNull(ctx.http, releaseUrl(tag, "timestamp.txt"), ctx.signal);
  if (body === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new NflverseSourceError("bad_timestamp", `nflverse ${tag}: timestamp.txt is not UTF-8`);
  }
  const releasedAt = parseNflverseTimestamp(text);
  if (releasedAt === null) {
    throw new NflverseSourceError("bad_timestamp", `nflverse ${tag}: unparseable timestamp.txt`);
  }
  return { version: versionString(releasedAt, seasons), released_at: releasedAt };
}

/** A private directory for one source's files, inside the run's temp dir when it gives one. */
export async function sourceTempDir(ctx: SourceContext, slug: string): Promise<string> {
  const base = (ctx as SourceContext & ContextExtras).tempDir ?? tmpdir();
  return mkdtemp(join(base, `ff-${slug}-`));
}

function assertHttps(finalUrl: string, url: string): void {
  let ok = false;
  try {
    ok = new URL(finalUrl).protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) throw new NflverseSourceError("download", `nflverse: ${url} was not served over https`);
}

/**
 * Downloads one release asset to `dest` (created exclusively, mode 0600): through the runner's
 * streaming `download` when it provides one, else through HttpGet. A non-200 status or an
 * oversize body fails the run naming the URL; a partial file is removed.
 */
export async function downloadAsset(
  ctx: SourceContext,
  url: string,
  dest: string,
  season: number | null,
): Promise<TempFile> {
  const extras = ctx as SourceContext & ContextExtras;
  const opts = { signal: ctx.signal, maxBytes: MAX_RELEASE_FILE_BYTES };
  try {
    let bytes: number;
    if (extras.download) {
      const res = await extras.download(url, { ...opts, dest, accept: "application/octet-stream" });
      if (res.status !== 200) {
        throw new NflverseSourceError(
          "download",
          `nflverse: ${url} answered ${String(res.status)}`,
          res.status,
        );
      }
      assertHttps(res.final_url, url);
      bytes = res.bytes;
    } else {
      const res = await ctx.http(url, { ...opts, accept: "application/octet-stream" });
      if (res.status !== 200) {
        throw new NflverseSourceError(
          "download",
          `nflverse: ${url} answered ${String(res.status)}`,
          res.status,
        );
      }
      assertHttps(res.final_url, url);
      if (res.body.length > MAX_RELEASE_FILE_BYTES) {
        throw new NflverseSourceError("download", `nflverse: ${url} exceeds the size cap`);
      }
      await writeFile(dest, res.body, { flag: "wx", mode: 0o600 });
      bytes = res.body.length;
    }
    if (bytes > MAX_RELEASE_FILE_BYTES) {
      throw new NflverseSourceError("download", `nflverse: ${url} exceeds the size cap`);
    }
    return { path: dest, bytes, season };
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}
