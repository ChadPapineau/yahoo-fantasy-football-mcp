// services.ts — what the MCP surface is given by the composition root (plan 01 §1.1: src/mcp may
// not import src/store or node:fs, so `ff serve` builds this object from the real store, provider
// and files and hands it to createServer). Typed only by domain/provider interfaces.
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
import type { TransactionsSeenRepository } from "../domain/league/types.js";
import type { RecommendationLogRepository } from "../domain/reclog/types.js";
import type { FantasyPlatform } from "../providers/platform.js";

/** The logger surface src/mcp needs (the cli Logger satisfies it; src/mcp may not import src/cli). */
export interface McpLogger {
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** A logger that drops everything (tests, and callers that pass none). */
export const NULL_LOGGER: McpLogger = Object.freeze({
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
});

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
