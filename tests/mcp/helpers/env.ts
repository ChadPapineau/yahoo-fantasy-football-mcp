// env.ts — the MCP tests' fixture world: a temp cache with the fixtures/nflverse excerpts published
// through the REAL runner + publisher (plan 05 §3.2), the real store, the real ManualLeagueProvider
// over fixtures/manual/league.yaml, the composition root's own buildServices, and a real Client
// connected in-process (InMemoryTransport). No network, no ~/.config, no ~/.cache.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { datasetDir, backupDir, storePath } from "../../../src/config/paths.js";
import { loadConfig, type Config } from "../../../src/config/schema.js";
import { buildServices, loadOverrides, loadTexts } from "../../../src/cli/serve.js";
import { createLogger, type Logger } from "../../../src/cli/log.js";
import { fixedClock, seededRng, type FixedClock } from "../../../src/domain/clock.js";
import { createServer } from "../../../src/mcp/server.js";
import type { McpServerOptions, McpServices } from "../../../src/mcp/services.js";
import { NFLVERSE_SOURCES } from "../../../src/sources/nflverse/index.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import { storeFactory } from "../../../src/store/index.js";
import type { Store } from "../../../src/store/types.js";
import { fakeHttp, fixtureRoutes } from "../../sources/nflverse/helpers/harness.js";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The in-repo fixture league (placeholder names only). */
export const FIXTURE_LEAGUE = path.join(ROOT, "fixtures", "manual", "league.yaml");
/** The fixture clock: Wednesday of week 4, 2026 (weeks 1–3 have stats; week 4 has none yet). */
export const T0 = "2026-09-30T18:00:00.000Z";

export const LEAGUE_KEY = "manual.l.example";
export const TEAM_A = "manual.l.example.t.1";
export const TEAM_B = "manual.l.example.t.2";

/** One fixture world. */
export interface World {
  readonly root: string;
  readonly cache: string;
  readonly clock: FixedClock;
  readonly store: Store;
  readonly config: Config;
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly logLines: string[];
  readonly logger: Logger;
  cleanup(): void;
}

export interface WorldOptions {
  /** Publish the nflverse fixture datasets (default true). */
  readonly publish?: boolean;
  /** Use a league file that does not exist (the "no-league-file" variant). */
  readonly noLeague?: boolean;
  /** Extra env for loadConfig (FF_TOOLSET, FF_WRITE_ENABLED, …). */
  readonly env?: Readonly<Record<string, string>>;
  /** Fixture mode (FF_FIXTURE_DIR set; default true — the fixture league lives in the repo). */
  readonly fixtureMode?: boolean;
  readonly clock?: string;
}

/** The sources and seasons published for the fixture world. */
export const PUBLISHED: readonly { id: keyof typeof NFLVERSE_SOURCES; seasons: number[] }[] = [
  { id: "nflverse:schedules", seasons: [2025, 2026] },
  { id: "nflverse:injuries", seasons: [2026] },
  { id: "nflverse:roster_weekly", seasons: [2026] },
  { id: "nflverse:stats_player_week", seasons: [2026] },
];

/** Builds a fixture world (store + published datasets + services). */
export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-mcp-")));
  chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  const cache = path.join(root, "cache");
  for (const d of [home, configDir, cache]) mkdirSync(d, { mode: 0o700 });
  const clock = fixedClock(o.clock ?? T0);
  const fixtureMode = o.fixtureMode ?? true;
  const env: Record<string, string> = {
    FF_CONFIG_DIR: configDir,
    FF_CACHE_DIR: cache,
    FF_LEAGUE_FILE: o.noLeague === true ? path.join(configDir, "league.yaml") : FIXTURE_LEAGUE,
    ...(fixtureMode ? { FF_FIXTURE_DIR: path.join(ROOT, "fixtures") } : {}),
    ...(o.env ?? {}),
  };
  const config = loadConfig({ env, file: undefined, home, repoRoot: ROOT });
  const store = storeFactory.open({
    path: storePath(cache),
    datasetDir: datasetDir(cache),
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
  if (o.publish !== false) {
    const publisher = storeFactory.openPublisher({
      storePath: storePath(cache),
      datasetDir: datasetDir(cache),
      clock,
    });
    try {
      const { http } = fakeHttp(fixtureRoutes());
      for (const p of PUBLISHED) {
        const r = await runRefresh(
          { source: NFLVERSE_SOURCES[p.id], seasons: p.seasons, week: null },
          {
            http,
            clock,
            rng: seededRng(1),
            publisher,
            refreshLog: store.repos.refreshLog,
            schedules: store.datasets.schedules,
            temp: fsTempArea(path.join(cache, "tmp")),
            sleep: () => Promise.resolve(),
          },
        );
        if (r.status !== "published")
          throw new Error(`fixture publish failed: ${p.id} ${r.status}`);
      }
    } finally {
      publisher.close();
    }
    store.reattachIfChanged();
  }
  const logLines: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (l) => logLines.push(l),
    now: () => clock.nowIso(),
  });
  const { services, options } = buildServices({
    config,
    store,
    clock,
    logger,
    texts: loadTexts(ROOT),
    overrides: loadOverrides(ROOT, logger),
  });
  return {
    root,
    cache,
    clock,
    store,
    config,
    services: { ...services, newSeed: () => 7 },
    options,
    logLines,
    logger,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A connected client over a server built from `world`: the legacy era through `server.connect`, or
 * the 2026-07-28 era through `serveStdio` (the production entry) over an in-memory transport.
 */
export async function connect(
  world: Pick<World, "services" | "options">,
  opts: { modern?: boolean; options?: Partial<McpServerOptions> } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const options = { ...world.options, ...opts.options };
  const [a, b] = InMemoryTransport.createLinkedPair();
  if (opts.modern === true) {
    const handle = serveStdio(() => createServer(world.services, options), { transport: a });
    const client = new Client(
      { name: "ff-test-client", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(b);
    return {
      client,
      close: async () => {
        await client.close();
        await handle.close();
      },
    };
  }
  const server = createServer(world.services, options);
  const client = new Client({ name: "ff-test-client", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The parsed envelope (or error body) from a tool result's one text block. */
export function body(r: unknown): Record<string, unknown> {
  const content = (r as { content: { type: string; text: string }[] }).content;
  const first = content[0];
  if (first === undefined) throw new Error("no content");
  return JSON.parse(first.text) as Record<string, unknown>;
}
