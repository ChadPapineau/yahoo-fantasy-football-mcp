// status-unreadable.test.ts — QA-1-038 (reopened): G1 ff_get_status (and ff://status/freshness) must
// never call a dataset "fresh" when the file the last refresh recorded is missing or cannot be
// served — the tools already refuse it (STALE_ONLY "missing or unreadable"), and `ff status` says
// UNREADABLE. Each damage kind is applied to a different source of a real fixture world: the damaged
// source reads `unreadable`, every other source keeps its state, and the dataset checks name it.
import { copyFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

interface Row {
  id: string;
  freshness: string;
  age_s: number | null;
}
interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

const file = (w: World, source: string): string =>
  path.join(w.cache, "ds", `${source.replace(":", "__")}.sqlite`);

const DAMAGE = {
  truncated: (w: World, s: string) => {
    truncateSync(file(w, s), Math.floor(statSync(file(w, s)).size / 2));
  },
  overwritten: (w: World, s: string) => {
    writeFileSync(file(w, s), Buffer.alloc(8192, 0x5a));
  },
  deleted: (w: World, s: string) => {
    rmSync(file(w, s));
  },
  // a readable dataset file of ANOTHER source, carrying its own source and version
  foreign: (w: World, s: string) => {
    const other = s === "nflverse:schedules" ? "nflverse:injuries" : "nflverse:schedules";
    copyFileSync(file(w, other), file(w, s));
  },
} as const;

/** Every damage kind, each on a different source (the sources rotate through the kinds). */
const CASES: readonly (readonly [keyof typeof DAMAGE, string])[] = [
  ["truncated", "nflverse:injuries"],
  ["overwritten", "nflverse:schedules"],
  ["deleted", "nflverse:stats_player_week"],
  ["foreign", "nflverse:roster_weekly"],
  ["foreign", "nflverse:injuries"],
];

async function status(w: World): Promise<{ sources: Row[]; checks: Check[]; report: Row[] }> {
  const { client, close } = await connect(w, { options: { weatherSource: "off" } });
  try {
    const r = await client.callTool({ name: "ff_get_status", arguments: { include_checks: true } });
    expect(r.isError).not.toBe(true);
    const d = body(r).data as { sources: Row[]; checks: Check[] };
    const res = await client.readResource({ uri: "ff://status/freshness" });
    const text = (res.contents[0] as { text?: string } | undefined)?.text ?? "{}";
    const report = (JSON.parse(text) as { data: { sources: Row[] } }).data.sources;
    return { sources: d.sources, checks: d.checks, report };
  } finally {
    await close();
  }
}

describe("G1 never calls a missing or unreadable dataset fresh (QA-1-038)", () => {
  it("control: a healthy fixture world reads fresh everywhere and every dataset check passes", async () => {
    const w = await makeWorld();
    try {
      const s = await status(w);
      expect(s.sources.map((x) => x.freshness)).toEqual(s.sources.map(() => "fresh"));
      const byId = new Map(s.checks.map((c) => [c.id, c]));
      expect(byId.get("datasets_loaded")?.ok).toBe(true);
      expect(byId.get("datasets_fresh")?.ok).toBe(true);
    } finally {
      w.cleanup();
    }
  }, 120_000);

  it.each(CASES.map(([kind, source]) => ({ kind, source })))(
    "$kind $source: that row reads unreadable, the others are untouched, the checks name it",
    async ({ kind, source }) => {
      const w = await makeWorld();
      try {
        const before = await status(w);
        DAMAGE[kind](w, source);
        const after = await status(w);
        for (const rows of [after.sources, after.report]) {
          for (const r of rows) {
            const was = before.sources.find((x) => x.id === r.id);
            if (r.id === source) expect(r.freshness, r.id).toBe("unreadable");
            else expect(r.freshness, r.id).toBe(was?.freshness);
          }
        }
        const detail = source.replace(/[^a-z_]/g, "_");
        const byId = new Map(after.checks.map((c) => [c.id, c]));
        expect(byId.get("datasets_loaded")).toMatchObject({ ok: false, detail });
        expect(byId.get("datasets_fresh")).toMatchObject({ ok: false, detail });
      } finally {
        w.cleanup();
      }
    },
    120_000,
  );
});
