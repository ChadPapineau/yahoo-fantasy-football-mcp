// no-network-in-server.test.ts — the server process never touches the network, even while it
// refreshes at answer time (season-fresh spec §6.6; plan 02 §1): all 19 tools run in-process with
// `globalThis.fetch` replaced by a throwing spy and every socket connect spied, while the real
// production spawner starts real `ff refresh --on-demand` children (from source, fixture mode — the
// child's own transport is the fixture tree). The spies are never called in this process; the
// children are.
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { everyCall } from "./helpers/calls.js";
import { connect, makeWorld, ROOT, type World } from "./helpers/env.js";

let world: World;
const fetchSpy = vi.fn(() => {
  throw new Error("network from the server process");
});
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  world = await makeWorld({
    env: { FF_ON_DEMAND_REFRESH: "wait" },
    // the production spawner, the child from source (tsx) — `dist/` may not be built in this run
    onDemand: { entry: path.join(ROOT, "src", "cli.ts"), execArgv: ["--import", "tsx"] },
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy;
}, 60_000);
afterAll(() => {
  globalThis.fetch = realFetch;
  world.cleanup();
});

describe("no network in the server process", () => {
  it("every tool answers, children refresh, and neither fetch nor a socket is used here", async () => {
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect");
    // two hours on: the fast sources are due a revalidation at answer time
    world.clock.advance(2 * 3_600_000);
    const c = await connect(world);
    try {
      for (const [name, args] of await everyCall(c.client)) {
        const r = await c.client.callTool({ name, arguments: args });
        expect(r.isError, name).not.toBe(true);
      }
    } finally {
      await c.close();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    // the refresh happened — in children
    const lines = world.logLines.map((l) => JSON.parse(l) as { event?: string });
    expect(lines.some((l) => l.event === "refresh.child_started")).toBe(true);
    expect(world.refresher.state()).toBe("wait");
  }, 300_000);
});
