// on-demand-off.test.ts — answer-time refresh switched off, and the surfaces that never refresh
// (season-fresh spec §6.2, §6.6; plan 03 L5): with FF_ON_DEMAND_REFRESH=off (the fixture-mode
// default) nothing is ever spawned and every envelope equals the one an ensureFresh answering null
// gives (request ids masked); and the diagnostics, the local write, the log browser, the league list,
// every resource and every prompt never call ensureFresh at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Spawner } from "../../src/cli/on-demand-refresh.js";
import type { McpServices } from "../../src/mcp/services.js";
import { everyCall, recordArgs } from "./helpers/calls.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

const spawned: string[][] = [];
const spawner: Spawner = (_cmd, args) => {
  spawned.push([...args]);
  return {
    pid: null,
    done: Promise.resolve({ code: 0, stdout: "" }),
    kill: () => undefined,
  };
};

let world: World;
beforeAll(async () => {
  world = await makeWorld({ onDemand: { spawn: spawner } });
}, 60_000);
afterAll(() => {
  world.cleanup();
});

const masked = (text: string): string => text.replace(/r-[0-9a-f]{12}/g, "r-masked");

describe("FF_ON_DEMAND_REFRESH=off", () => {
  it("is the fixture-mode default: no ensureFresh, a refresher that is off", () => {
    expect(world.config.onDemandRefresh).toBe("off");
    expect(world.options.onDemand).toBe("off");
    expect(world.refresher.state()).toBe("off");
    expect("ensureFresh" in world.services).toBe(false);
  });

  it("never spawns, and every envelope equals today's (an ensureFresh that answers null)", async () => {
    const nulls: McpServices = { ...world.services, ensureFresh: () => Promise.resolve(null) };
    const off = await connect(world);
    const on = await connect({ services: nulls, options: world.options });
    try {
      const calls = (await everyCall(off.client)).map(
        ([name, args]): [string, Record<string, unknown>] =>
          // a client_ref makes the second record the same log row (idempotent), so both answers match
          name === "ff_record_recommendation"
            ? [name, { ...args, client_ref: "off-equal" }]
            : [name, args],
      );
      for (const [name, args] of calls) {
        const a = await off.client.callTool({ name, arguments: args });
        const b = await on.client.callTool({ name, arguments: args });
        const ta = (a.content as { text: string }[])[0]?.text ?? "";
        const tb = (b.content as { text: string }[])[0]?.text ?? "";
        expect(a.isError, `${name} ${ta.slice(0, 300)}`).not.toBe(true);
        // the second record of the same client_ref is the same row, marked deduplicated; the other
        // server's call ledger never saw the cited call (its warning differs by design)
        const norm = (t: string): string =>
          name === "ff_record_recommendation"
            ? JSON.stringify((JSON.parse(t) as { data: { log_id: string } }).data.log_id)
            : masked(t);
        expect(norm(ta), name).toBe(norm(tb));
      }
    } finally {
      await off.close();
      await on.close();
    }
    expect(spawned).toEqual([]);
  }, 120_000);
});

describe("surfaces that never refresh (plan 03 L5)", () => {
  it("status, record, the log browser, the league list, transactions, resources and prompts never call ensureFresh", async () => {
    let calls = 0;
    const spy: McpServices = {
      ...world.services,
      ensureFresh: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    };
    const c = await connect({ services: spy, options: world.options });
    try {
      const rec = await recordArgs(c.client); // E2 itself refreshes: count from here on
      calls = 0;
      for (const [name, args] of [
        ["ff_get_status", { include_checks: true }],
        ["ff_get_status", {}],
        ["ff_record_recommendation", rec],
        ["ff_list_recommendations", {}],
        ["ff_list_leagues", {}],
        ["ff_list_transactions", {}],
      ] as const) {
        const r = await c.client.callTool({ name, arguments: args });
        expect(r.isError, `${name} ${JSON.stringify(body(r))}`).not.toBe(true);
      }
      const logged = await c.client.callTool({ name: "ff_list_recommendations", arguments: {} });
      const logId = (body(logged) as { data: { items: { log_id: string }[] } }).data.items[0]
        ?.log_id;
      for (const uri of [
        "ff://league",
        "ff://league/settings",
        "ff://status",
        "ff://status/freshness",
        "ff://docs/tool-outputs",
        "ff://rec/week/4",
        ...(logId === undefined ? [] : [`ff://rec/${logId}`]),
      ])
        await c.client.readResource({ uri });
      for (const p of (await c.client.listPrompts()).prompts)
        await c.client.getPrompt({
          name: p.name,
          arguments: p.name === "ff.stream" ? { position: "K" } : {},
        });
    } finally {
      await c.close();
    }
    expect(calls).toBe(0);
    expect(spawned).toEqual([]);
  }, 120_000);

  it("every analytics and dataset tool does call it (once per call)", async () => {
    let calls = 0;
    const spy: McpServices = {
      ...world.services,
      ensureFresh: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    };
    const c = await connect({ services: spy, options: world.options });
    try {
      const list = await everyCall(c.client);
      calls = 0;
      let expected = 0;
      for (const [name, args] of list) {
        await c.client.callTool({ name, arguments: args });
        if (
          ![
            "ff_list_leagues",
            "ff_list_transactions",
            "ff_record_recommendation",
            "ff_list_recommendations",
            "ff_get_status",
          ].includes(name)
        )
          expected += 1;
      }
      expect(calls).toBe(expected);
    } finally {
      await c.close();
    }
  }, 120_000);
});
