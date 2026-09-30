// serve.test.ts — `ff serve` in-process (plan 03 §1): the composition root answers JSON-RPC on the
// given stdout only, logs JSON lines on stderr only, exits 0 on stdin EOF / stdout EPIPE / SIGHUP
// with the store closed, 2 on bad usage/config/unsafe cache dir, 1 on a newer store or a failed close;
// and the helpers (frontmatter, package texts, overrides, weather mapping).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT,
  loadOverrides,
  loadTexts,
  readPackageText,
  serve,
  storeWeather,
  stripFrontmatter,
} from "../../src/cli/serve.js";
import { createLogger } from "../../src/cli/log.js";
import type { Config } from "../../src/config/schema.js";
import { storeFactory } from "../../src/store/index.js";
import { StoreVersionError, type StoreFactory } from "../../src/store/types.js";
import { FIXTURE_LEAGUE, ROOT } from "./helpers/env.js";

interface Harness {
  root: string;
  env: Record<string, string>;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  out: string[];
  err: string[];
}

let h: Harness;
beforeEach(() => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-serve-")));
  chmodSync(root, 0o700);
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  stdout.on("data", (b: Buffer) => out.push(...b.toString("utf8").split("\n").filter(Boolean)));
  stderr.on("data", (b: Buffer) => err.push(...b.toString("utf8").split("\n").filter(Boolean)));
  h = {
    root,
    env: {
      HOME: path.join(root, "home"),
      FF_CONFIG_DIR: path.join(root, "config"),
      FF_CACHE_DIR: path.join(root, "cache"),
      FF_LEAGUE_FILE: FIXTURE_LEAGUE,
      FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
      FF_LOG_LEVEL: "debug",
    },
    stdin,
    stdout,
    stderr,
    out,
    err,
  };
});
afterEach(() => {
  rmSync(h.root, { recursive: true, force: true });
});

const run = (
  over: { argv?: string[]; env?: Record<string, string> } = {},
  factory?: StoreFactory,
) =>
  serve(
    {
      argv: over.argv ?? [],
      env: { ...h.env, ...over.env },
      stdin: h.stdin,
      stdout: h.stdout,
      stderr: h.stderr,
    },
    { signals: false, packageRoot: ROOT, ...(factory === undefined ? {} : { factory }) },
  );

const send = (msg: unknown): void => {
  h.stdin.write(`${JSON.stringify(msg)}\n`);
};
const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
};

describe("serve: lifecycle", () => {
  it("answers initialize + tools/list on stdout only; stdin EOF → exit 0", async () => {
    const done = run();
    send(INIT);
    await waitFor(() => h.out.length >= 1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => h.out.length >= 2);
    const [init, list] = h.out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "fantasy-football-mcp-server" } },
    });
    const tools = (list?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toHaveLength(20); // 19 + ff_debug_echo (fixture mode)
    for (const l of h.out) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc).toBe("2.0");
    h.stdin.end();
    expect(await done).toBe(EXIT.ok);
    for (const l of h.err) expect(() => JSON.parse(l) as unknown).not.toThrow();
    expect(h.err.join("\n")).toContain('"event":"serve.ready"');
    expect(h.err.join("\n")).toContain('"event":"serve.shutdown"');
  });

  it("stdout EPIPE → a clean exit 0", async () => {
    const done = run();
    send(INIT);
    await waitFor(() => h.out.length >= 1);
    h.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(await done).toBe(EXIT.ok);
    expect(h.err.join("\n")).toContain('"reason":"epipe"');
  });

  it("SIGHUP (handlers installed) → exit 0; handlers are removed afterwards", async () => {
    const before = process.listenerCount("SIGHUP");
    const done = serve(
      { argv: [], env: h.env, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr },
      { packageRoot: ROOT, watchdogMs: 60_000 },
    );
    await waitFor(() => h.err.some((l) => l.includes("serve.ready")));
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    process.emit("SIGHUP", "SIGHUP");
    expect(await done).toBe(EXIT.ok);
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("a store close failure turns the exit code into 1", async () => {
    const factory: StoreFactory = {
      open: (o) => {
        const s = storeFactory.open(o);
        return new Proxy(s, {
          get: (t, k) =>
            k === "close"
              ? () => {
                  t.close();
                  throw new Error("disk gone");
                }
              : (Reflect.get(t, k) as unknown),
        });
      },
      openPublisher: (o) => storeFactory.openPublisher(o),
    };
    const done = run({}, factory);
    await waitFor(() => h.err.some((l) => l.includes("serve.ready")));
    h.stdin.end();
    expect(await done).toBe(EXIT.error);
    expect(h.err.join("\n")).toContain("store.close_failed");
  });
});

describe("serve: startup refusals (plan 03 §1.3 exit codes)", () => {
  it("an argument → 2 (serve takes none)", async () => {
    expect(await run({ argv: ["--port", "1"] })).toBe(EXIT.config);
    expect(h.out).toEqual([]);
  });
  it("invalid config → 2 with one stderr line per issue, nothing on stdout", async () => {
    expect(await run({ env: { FF_TOOLSET: "bogus", FF_LOG_LEVEL: "loud" } })).toBe(EXIT.config);
    expect(h.out).toEqual([]);
    expect(h.err.filter((l) => l.includes("config.invalid"))).toHaveLength(2);
  });
  it("a cache dir with group/other bits → 2 (never chmod-ed silently)", async () => {
    chmodSync(path.join(h.root, "cache"), 0o755);
    expect(await run()).toBe(EXIT.config);
    expect(h.err.join("\n")).toContain("store.open_failed");
  });
  it("a store from a newer binary → 1", async () => {
    const factory: StoreFactory = {
      open: () => {
        throw new StoreVersionError(99, 1);
      },
      openPublisher: (o) => storeFactory.openPublisher(o),
    };
    expect(await run({}, factory)).toBe(EXIT.error);
  });
  it("a relative FF_CACHE_DIR → 2", async () => {
    expect(await run({ env: { FF_CACHE_DIR: "relative/cache" } })).toBe(EXIT.config);
  });
});

describe("serve helpers", () => {
  it("stripFrontmatter removes only a leading --- block", () => {
    expect(stripFrontmatter("---\nname: x\n---\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("no front\n---\n")).toBe("no front\n---\n");
    expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
    expect(stripFrontmatter("---\na: 1\n---")).toBe("");
  });
  it("loadTexts reads the four package texts without frontmatter; a missing root gives nulls", () => {
    const t = loadTexts(ROOT);
    for (const v of Object.values(t)) expect(typeof v).toBe("string");
    expect(t.start_sit?.startsWith("---")).toBe(false);
    expect(loadTexts(path.join(h.root, "nowhere"))).toEqual({
      start_sit: null,
      stream: null,
      retro: null,
      tool_outputs: null,
    });
    expect(readPackageText(path.join(h.root, "missing.md"))).toBeNull();
    writeFileSync(path.join(h.root, "big.md"), "x".repeat(300 * 1024));
    expect(readPackageText(path.join(h.root, "big.md"))).toBeNull();
  });
  it("loadOverrides: the package file loads; a broken one is logged and serving continues", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => lines.push(l) });
    expect(Array.isArray(loadOverrides(ROOT, log))).toBe(true);
    const bad = path.join(h.root, "pkg");
    mkdirSync(path.join(bad, "data", "crosswalk"), { recursive: true });
    writeFileSync(path.join(bad, "data", "crosswalk", "overrides.yaml"), "version: [\n");
    expect(loadOverrides(bad, log)).toEqual([]);
    expect(lines.join("\n")).toContain("crosswalk.overrides_unavailable");
  });
  it("storeWeather maps FF_WEATHER_SOURCE", () => {
    const c = (w: string) => ({ weatherSource: w }) as unknown as Config;
    expect(storeWeather(c("open-meteo"))).toBe("weather:open_meteo");
    expect(storeWeather(c("nws"))).toBe("weather:nws");
    expect(storeWeather(c("off"))).toBeUndefined();
  });
});
