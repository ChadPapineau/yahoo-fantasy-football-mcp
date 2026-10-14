// on-demand-network.test.ts — answer-time refresh under network faults (season-fresh spec §6.4,
// plan 05 §4.1): the served path over the real store, the real runner and publisher (`ff refresh
// --on-demand` run in-process as the "child", argv parsed back from the orchestrator's fixed command
// line) with a fault-injecting transport over the fixture tree. Offline answers inside the budget with
// the data still inside its hard limit, `failed:network` and a warning, and starts nothing during the
// backoff; a slow network answers `in_progress` at 6 s and the next call serves the release with no
// warning; 429 + Retry-After makes ≤ 2 GETs and a backoff; 503 then 200 retries once; never loaded +
// offline is `refresh_failed`, never loaded + online answers normally; expired + failure is
// STALE_ONLY and allow_stale still returns the data. No socket is ever opened.
import { afterEach, describe, expect, it } from "vitest";
import { fixtureFetch } from "../../src/cli/fixture-fetch.js";
import type { ChildHandle, Spawner } from "../../src/cli/on-demand-refresh.js";
import { refresh } from "../../src/cli/refresh.js";
import type { FetchLike } from "../../src/http/client.js";
import { STALE_ONLY_VARIANTS } from "../../src/mcp/errors.js";
import type { RefreshReport } from "../../src/mcp/services.js";
import { FIXTURES, makeIo, type Sandbox } from "../cli/helpers.js";
import { body, connect, makeWorld, type World } from "../mcp/helpers/env.js";

const H = 3_600_000;

/** The transport the "child" sees; tests swap it between calls. */
interface Net {
  fetch: FetchLike;
  gets: number;
}

/**
 * A spawner that runs `ff refresh` in-process: the args after the fixed prefix are the targets
 * (exactly what a real child would parse), the world's config and clock, `transport` as the network.
 */
function inProcess(getWorld: () => World, net: Net, spawns: string[][]): Spawner {
  return (_cmd, args) => {
    spawns.push([...args]);
    const at = args.indexOf("--notify");
    const targets = args.slice(at + 1);
    const w = getWorld();
    const sb: Sandbox = {
      dir: w.root,
      home: w.env.HOME ?? "",
      configDir: w.config.configDir,
      cacheDir: w.config.cacheDir,
      cleanup: () => undefined,
    };
    const io = makeIo(sb, { clock: w.clock, env: { ...w.env } });
    const abort = new AbortController();
    const transport: FetchLike = (url, init) => {
      net.gets += 1;
      return net.fetch(url, init);
    };
    const done = refresh(
      io,
      w.config,
      w.logger,
      {
        targets,
        force: false,
        notify: false,
        json: true,
        onDemand: true,
        noMigrate: true,
        expectVersion: args[args.indexOf("--expect-version") + 1] ?? null,
        dryRun: false,
        transport,
      },
      abort.signal,
    ).then((code) => ({ code, stdout: io.out.text }));
    const handle: ChildHandle = {
      pid: null,
      done,
      kill: () => {
        abort.abort();
      },
    };
    return handle;
  };
}

const fixtures = fixtureFetch(FIXTURES);
const offline: FetchLike = () =>
  Promise.reject(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    }),
  );

let world: World | null = null;
afterEach(() => {
  world?.cleanup();
  world = null;
});

async function setup(o: { publish?: boolean } = {}): Promise<{
  w: World;
  net: Net;
  spawns: string[][];
}> {
  const net: Net = { fetch: fixtures, gets: 0 };
  const spawns: string[][] = [];
  const w = await makeWorld({
    env: { FF_ON_DEMAND_REFRESH: "wait" },
    ...(o.publish === false ? { publish: false } : {}),
    onDemand: { spawn: inProcess(() => w, net, spawns) },
  });
  world = w;
  return { w, net, spawns };
}

interface Env {
  data: unknown;
  meta: { refresh?: RefreshReport };
  warnings: string[];
}

async function injuries(
  w: World,
  args: Record<string, unknown> = {},
): Promise<{
  isError: boolean;
  b: Env & { error?: { code: string; message: string; hint: string } };
  ms: number;
}> {
  const c = await connect(w);
  try {
    const t0 = performance.now();
    const r = await c.client.callTool({ name: "ff_get_injuries", arguments: args });
    return { isError: r.isError === true, b: body(r) as never, ms: performance.now() - t0 };
  } finally {
    await c.close();
  }
}

const row = (b: Env, source: string) => b.meta.refresh?.sources.find((s) => s.source === source);

describe("offline", () => {
  it("answers inside the budget with the data it has, failed:network and a warning; no spawn during the backoff", async () => {
    const { w, net, spawns } = await setup();
    w.clock.advance(2 * H);
    net.fetch = offline;
    const first = await injuries(w);
    expect(first.isError, JSON.stringify(first.b).slice(0, 300)).toBe(false);
    expect(row(first.b, "nflverse:injuries")).toMatchObject({ outcome: "failed", code: "network" });
    expect(first.b.warnings).toContain(
      "could not refresh nflverse:injuries (network); this answer uses the release checked 2h ago",
    );
    expect(first.ms).toBeLessThan(15_000);
    const n = spawns.length;
    w.clock.advance(60_000);
    const second = await injuries(w);
    expect(second.isError).toBe(false);
    expect(spawns.length).toBe(n);
    expect(row(second.b, "nflverse:injuries")?.outcome).toBe("backoff");
    expect(
      second.b.warnings.some((l) => l.startsWith("not retrying nflverse:injuries until ")),
    ).toBe(true);
  }, 120_000);
});

describe("slow network", () => {
  it("in_progress at 6 s; the next call serves the release with no warning and no new spawn", async () => {
    const { w, net, spawns } = await setup();
    w.clock.advance(2 * H);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    net.fetch = async (url, init) => {
      await gate;
      return fixtures(url, init);
    };
    const first = await injuries(w);
    expect(first.isError).toBe(false);
    expect(row(first.b, "nflverse:injuries")?.outcome).toBe("in_progress");
    expect(first.ms).toBeGreaterThanOrEqual(5_500);
    expect(
      first.b.warnings.some((l) => l.startsWith("refreshing nflverse:injuries in the background")),
    ).toBe(true);
    release();
    // the in-flight child finishes; its publish is attached by the next call's beforeCall
    await new Promise((r) => setTimeout(r, 3_000));
    const n = spawns.length;
    const second = await injuries(w);
    expect(second.isError).toBe(false);
    expect(second.b.warnings.filter((l) => l.includes("refresh"))).toEqual([]);
    expect(spawns.length).toBe(n);
  }, 120_000);
});

describe("rate limited and server errors", () => {
  it("429 + Retry-After: at most 2 GETs, then a backoff (no spawn)", async () => {
    const { w, net, spawns } = await setup();
    w.clock.advance(2 * H);
    net.fetch = () =>
      Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "1800" } }));
    const first = await injuries(w);
    expect(first.isError).toBe(false);
    // the first source's 429 sets the provider pause: the child's later sources skip under it
    expect(row(first.b, "nflverse:schedules")).toMatchObject({
      outcome: "failed",
      code: "rate_limited",
    });
    expect(row(first.b, "nflverse:injuries")).toMatchObject({ code: "rate_limited" });
    expect(["failed", "backoff"]).toContain(row(first.b, "nflverse:injuries")?.outcome);
    expect(net.gets).toBeLessThanOrEqual(2);
    const n = spawns.length;
    const second = await injuries(w);
    expect(row(second.b, "nflverse:injuries")).toMatchObject({
      outcome: "backoff",
      code: "rate_limited",
    });
    expect(spawns.length).toBe(n);
  }, 120_000);

  it("503 then 200: one retry, and the release is revalidated", async () => {
    const { w, net } = await setup();
    w.clock.advance(2 * H);
    let first = true;
    net.fetch = (url, init) => {
      if (first) {
        first = false;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return fixtures(url, init);
    };
    const r = await injuries(w);
    expect(r.isError).toBe(false);
    expect(["revalidated", "updated"]).toContain(row(r.b, "nflverse:injuries")?.outcome);
  }, 120_000);
});

describe("nothing usable loaded", () => {
  it("never loaded + offline: STALE_ONLY refresh_failed naming the code", async () => {
    const { w, net } = await setup({ publish: false });
    net.fetch = offline;
    const r = await injuries(w);
    expect(r.isError).toBe(true);
    expect(r.b.error?.code).toBe("STALE_ONLY");
    expect(r.b.error?.message).toBe(STALE_ONLY_VARIANTS.refresh_failed.message);
    expect(r.b.error?.hint).toContain("(network)");
  }, 120_000);

  it("never loaded + online (fixture): a normal answer within the 15 s repair budget", async () => {
    const { w } = await setup({ publish: false });
    const r = await injuries(w);
    expect(r.isError, JSON.stringify(r.b).slice(0, 400)).toBe(false);
    expect(r.ms).toBeLessThan(15_000);
    expect(row(r.b, "nflverse:schedules")?.outcome).toBe("updated");
  }, 120_000);

  it("expired + failure: STALE_ONLY refresh_failed; allow_stale still returns the data", async () => {
    const { w, net } = await setup();
    w.clock.advance(40 * H); // past injuries' 36 h hard limit
    net.fetch = offline;
    const r = await injuries(w);
    expect(r.isError).toBe(true);
    expect(r.b.error?.message).toBe(STALE_ONLY_VARIANTS.refresh_failed.message);
    const stale = await injuries(w, { allow_stale: true });
    expect(stale.isError, JSON.stringify(stale.b).slice(0, 300)).toBe(false);
  }, 120_000);
});
