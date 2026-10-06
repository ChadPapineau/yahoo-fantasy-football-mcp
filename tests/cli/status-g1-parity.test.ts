// status-g1-parity.test.ts — `ff status` and G1 ff_get_status read the same cache the same way
// (QA-1-038 follow-up). A source with a successful refresh whose current dataset file cannot be
// served — deleted, replaced by a directory, damaged, or another source's — is `unreadable` in both,
// with `ff refresh <source>` as the repair; `never_loaded` is only for a source never refreshed.
// `ff status` used to read a deleted (or non-regular) current file as `never_loaded` while G1 said
// `unreadable`. The property: for every damage kind, each source's `ff status` state is G1's freshness.
import { copyFileSync, mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus, sourceStatuses, type StatusReport } from "../../src/cli/status.js";
import { body, connect, makeWorld, type World } from "../mcp/helpers/env.js";

const file = (w: World, source: string): string =>
  path.join(w.cache, "ds", `${source.replace(":", "__")}.sqlite`);

const DAMAGE = {
  none: () => undefined,
  deleted: (w: World, s: string) => {
    rmSync(file(w, s));
  },
  directory: (w: World, s: string) => {
    rmSync(file(w, s));
    mkdirSync(file(w, s));
  },
  truncated: (w: World, s: string) => {
    truncateSync(file(w, s), Math.floor(statSync(file(w, s)).size / 2));
  },
  overwritten: (w: World, s: string) => {
    writeFileSync(file(w, s), Buffer.alloc(8192, 0x5a));
  },
  foreign: (w: World, s: string) => {
    const other = s === "nflverse:schedules" ? "nflverse:injuries" : "nflverse:schedules";
    copyFileSync(file(w, other), file(w, s));
  },
} as const;

const CASES: readonly (readonly [keyof typeof DAMAGE, string])[] = [
  ["none", "nflverse:injuries"],
  ["deleted", "nflverse:injuries"],
  ["deleted", "nflverse:stats_player_week"],
  ["directory", "nflverse:schedules"],
  ["truncated", "nflverse:roster_weekly"],
  ["overwritten", "nflverse:injuries"],
  ["foreign", "nflverse:roster_weekly"],
];

async function g1(w: World): Promise<Map<string, string>> {
  const { client, close } = await connect(w, { options: { weatherSource: "off" } });
  try {
    const r = await client.callTool({ name: "ff_get_status", arguments: {} });
    expect(r.isError).not.toBe(true);
    const d = body(r).data as { sources: { id: string; freshness: string }[] };
    return new Map(d.sources.map((x) => [x.id, x.freshness]));
  } finally {
    await close();
  }
}

describe("ff status reads a current dataset file the way G1 does (QA-1-038)", () => {
  it.each(CASES.map(([kind, source]) => ({ kind, source })))(
    "$kind $source: every source's ff status state is G1's freshness",
    async ({ kind, source }) => {
      const w = await makeWorld();
      try {
        DAMAGE[kind](w, source);
        const gs = await g1(w);
        const mine = sourceStatuses(w.store, w.config, w.clock.nowMs());
        let compared = 0;
        for (const s of mine) {
          const want = gs.get(s.source);
          if (want === undefined) continue; // a source G1 does not list in this configuration
          expect(s.state, s.source).toBe(want);
          compared += 1;
        }
        expect(compared).toBeGreaterThanOrEqual(4);
        const row = mine.find((s) => s.source === source);
        if (kind === "none") {
          expect(row?.state).toBe("fresh");
          return;
        }
        expect(row?.state).toBe("unreadable");
        // the dashboard names the repair for that source
        const report = { sources: mine } as unknown as StatusReport;
        const lines = renderSources(report);
        expect(lines).toContain(
          `→ ${source}: dataset file unreadable — run \`ff refresh ${source}\``,
        );
      } finally {
        w.cleanup();
      }
    },
    120_000,
  );
});

/** The repair lines of the text dashboard for `r.sources` (the rest of the report is not needed). */
function renderSources(r: StatusReport): string[] {
  const full: StatusReport = {
    version: "0",
    node: "0",
    generated_at: "2026-09-30T18:00:00.000Z",
    config: {
      config_dir: "/c",
      cache_dir: "/k",
      league_file: "/l",
      weather_source: "off",
      toolset: "core",
      fixture_mode: true,
      warnings: [],
    },
    store: {
      state: "ok",
      path: "/s",
      size_bytes: 0,
      schema_version: 1,
      binary_schema_version: 1,
      cache_misses_busy: 0,
      message: null,
    },
    sources: r.sources,
    journal: null,
    launchd: { supported: false, installed: [], missing: [] },
  };
  return renderStatus(full).filter((l) => l.startsWith("→"));
}
