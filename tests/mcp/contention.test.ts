// contention.test.ts — a foreign writer holds store.sqlite's write lock (plan 10 A4a at the MCP
// surface; plan 01 §5.3): reads keep answering, a best-effort projection write becomes a counted miss
// with a warning, and the required recommendation-log write answers STORE_BUSY within ~1 s.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_TABLE } from "../../src/mcp/errors.js";
import { TEAM_A, body, connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
let c: Awaited<ReturnType<typeof connect>>;
let rec: unknown;
beforeAll(async () => {
  world = await makeWorld();
  c = await connect(world);
  rec = (
    body(await c.client.callTool({ name: "ff_analyze_lineup", arguments: { week: 3 } })).data as {
      rec: unknown;
    }
  ).rec;
}, 60_000);
afterAll(async () => {
  await c.close();
  world.cleanup();
});

describe("under a held write lock", () => {
  it("reads answer, E1 counts its unstored projections, E12 is STORE_BUSY within ~1 s", async () => {
    const holder = new DatabaseSync(path.join(world.cache, "store.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, args] of [
        ["ff_get_roster", { week: 4 }],
        ["ff_get_league", {}],
        ["ff_list_recommendations", {}],
        ["ff_get_status", {}],
      ] as const) {
        const r = await c.client.callTool({ name, arguments: args });
        expect(r.isError, name).not.toBe(true);
      }
      const p = body(
        await c.client.callTool({
          name: "ff_project_players",
          arguments: {
            players: { player_keys: ["manual.p.00-0034857"] },
            horizon: "week",
            seed: 3,
          },
        }),
      ) as { warnings: string[] };
      expect(p.warnings.some((w) => w.endsWith("projections were not stored (store busy)"))).toBe(
        true,
      );
      const t0 = Date.now();
      const r = await c.client.callTool({
        name: "ff_record_recommendation",
        arguments: { kind: "lineup", week: 3, rec, client_ref: "busy-1" },
      });
      const took = Date.now() - t0;
      expect(r.isError).toBe(true);
      const e = (body(r) as { error: { code: string; retryable: boolean; hint: string } }).error;
      expect(e.code).toBe("STORE_BUSY");
      expect(e.retryable).toBe(true);
      expect(e.hint).toBe(ERROR_TABLE.STORE_BUSY.hint);
      expect(took).toBeLessThan(1600);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    const after = await c.client.callTool({
      name: "ff_record_recommendation",
      arguments: { kind: "lineup", week: 3, rec, client_ref: "busy-1" },
    });
    expect(after.isError).not.toBe(true);
    expect(TEAM_A).toContain("manual.l.example");
  }, 30_000);
});
