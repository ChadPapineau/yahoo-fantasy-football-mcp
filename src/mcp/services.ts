// services.ts — what the MCP surface is given by the composition root (plan 01 §1.1: src/mcp may
// not import src/store or node:fs, so `ff serve` builds this object from the real store, provider
// and files and hands it to createServer). Typed only by domain/provider interfaces.
import type { DatasetSourceId } from "../config/freshness.js";
import type { Toolset, WeatherSource } from "../config/schema.js";
import type {
  DatasetReaders,
  ProjectionRepository,
  RefreshLogRepository,
  StoreStats,
  WriteJournalRepository,
} from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type {
  CrosswalkOverride,
  CrosswalkRepository,
  RosterWeeklyReader,
} from "../domain/crosswalk/types.js";
import type { IsoInstant, TransactionsSeenRepository } from "../domain/league/types.js";
import type { RecommendationLogRepository } from "../domain/reclog/types.js";
import type { FantasyPlatform } from "../providers/platform.js";

// --- answer-time refresh (season-fresh spec §6, plan 07 §2 `meta.refresh`) ------------------------------

/**
 * What became of one source's answer-time refresh: `updated` (a new release was published),
 * `revalidated` (the release is unchanged and was re-checked), `in_progress` (still running when the
 * wait budget ended — the next call attaches it), `joined` (another process is refreshing it),
 * `failed`, `backoff` (not retried until `next_retry_at`), `throttled` (the per-server cap), `skipped`
 * (nothing to fetch: not published upstream, off-season, no games).
 */
export const REFRESH_OUTCOMES = [
  "updated",
  "revalidated",
  "in_progress",
  "joined",
  "failed",
  "backoff",
  "throttled",
  "skipped",
] as const;
export type RefreshOutcome = (typeof REFRESH_OUTCOMES)[number];

/** Why, in a fixed vocabulary (never upstream text); null when the outcome says it all. */
export const REFRESH_OUTCOME_CODES = [
  "network",
  "rate_limited",
  "not_found",
  "schema",
  "aborted",
  "locked",
  "spawn",
  "version",
  "migration",
  "not_published",
  "off_season",
  "no_games",
  "internal",
] as const;
export type RefreshOutcomeCode = (typeof REFRESH_OUTCOME_CODES)[number] | null;

/** One source's line of `meta.refresh`. */
export interface RefreshSourceReport {
  readonly source: DatasetSourceId;
  readonly outcome: RefreshOutcome;
  readonly code: RefreshOutcomeCode;
  /** When the refresh this answer waited on or joined started; null when none ran. */
  readonly started_at: IsoInstant | null;
  /** When this outcome was judged. */
  readonly at: IsoInstant;
  /** The earliest instant a retry is allowed (backoff, a not-yet-published season), or null. */
  readonly next_retry_at: IsoInstant | null;
}

/** `meta.refresh`: present only when a refresh was attempted, joined or held back for this answer. */
export interface RefreshReport {
  /** FF_ON_DEMAND_REFRESH (`background` never waits). */
  readonly mode: "wait" | "background";
  /** 1..8 rows, schedules first. */
  readonly sources: readonly RefreshSourceReport[];
}

/** The logger surface src/mcp needs (the cli Logger satisfies it; src/mcp may not import src/cli). */
export interface McpLogger {
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Texts the composition root read from the package (Skill bodies, the cheat-sheet). */
export interface ServerTexts {
  /** `skills/start-sit/SKILL.md` body (frontmatter stripped), or null when absent. */
  readonly start_sit: string | null;
  /** `skills/stream-kdef/SKILL.md` body. */
  readonly stream: string | null;
  /** `skills/retro/SKILL.md` body. */
  readonly retro: string | null;
  /** `skills/_shared/references/tool-outputs.md` (served as `ff://docs/tool-outputs`). */
  readonly tool_outputs: string | null;
}

/** Everything the tools, resources and prompts read or write. */
export interface McpServices {
  readonly clock: Clock;
  /** The league source (ManualLeagueProvider in this build). */
  readonly platform: FantasyPlatform;
  /** The read-only dataset ports over the attached files. */
  readonly datasets: DatasetReaders;
  /** The crosswalk's nflverse roster port. */
  readonly rosterWeekly: RosterWeeklyReader;
  readonly recommendationLog: RecommendationLogRepository;
  readonly projections: ProjectionRepository;
  /** Persisted crosswalk pairs (read here; the tools never write the crosswalk — decision). */
  readonly crosswalk: Pick<CrosswalkRepository, "get" | "count">;
  readonly refreshLog: Pick<RefreshLogRepository, "current" | "latest" | "consecutiveFailures">;
  readonly writeJournal: WriteJournalRepository;
  readonly transactionsSeen: Pick<TransactionsSeenRepository, "list" | "oldestSeen">;
  /** The checked-in crosswalk overrides (loaded once by the composition root). */
  readonly crosswalkOverrides: readonly CrosswalkOverride[];
  /** Store health for G1 (`path` is never shown to the model). */
  storeStats(): StoreStats;
  /** Called at the start of every tool call / resource read (e.g. `Store.reattachIfChanged`). */
  beforeCall?(): void;
  /** Seed source for calls without `seed` (default: crypto). */
  readonly newSeed?: () => number;
  readonly logger: McpLogger;
}

/** Server-level options (from the resolved Config and the package). */
export interface McpServerOptions {
  /** Server version (package.json). */
  readonly version: string;
  /** `FF_TOOLSET`. */
  readonly toolset: Toolset;
  /** `FF_FIXTURE_DIR` is set (registers the fixture-only debug tool, G3). */
  readonly fixtureMode: boolean;
  /** `FF_LEAGUE_KEYS` allow-list (empty = no extra restriction). */
  readonly leagueKeys: readonly string[];
  /** `FF_WEATHER_SOURCE`. */
  readonly weatherSource: WeatherSource;
  /** Whether the operator set FF_WRITE_ENABLED=1 (reported, never honoured — plan 02 §3.4). */
  readonly writeRequested: boolean;
  readonly texts: ServerTexts;
}
