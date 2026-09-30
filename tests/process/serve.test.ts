// serve.test.ts — `ff serve` as a real child process (plan 05 §4.2; plan 03 §1.3; plan 10 A13):
// stdin EOF → exit 0 within 1 s, SIGTERM and SIGINT → exit 0, bad config → exit 2 with nothing on
// stdout, and nothing but JSON-RPC ever on stdout. Spawns `node --import tsx` on a TS-free entry
// (tests/process/fixtures/serve-entry.mjs) over the fixture league; no network, temp dirs only.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(ROOT, "tests", "process", "fixtures", "serve-entry.mjs");

interface Child {
  proc: ChildProcessWithoutNullStreams;
  out: string[];
  err: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

let root: string;
let env: Record<string, string>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-proc-")));
  chmodSync(root, 0o700);
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  env = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(root, "home"),
    FF_CONFIG_DIR: path.join(root, "config"),
    FF_CACHE_DIR: path.join(root, "cache"),
    FF_LEAGUE_FILE: path.join(ROOT, "fixtures", "manual", "league.yaml"),
    FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
    FF_LOG_LEVEL: "info",
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function start(extra: Record<string, string> = {}): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    cwd: ROOT,
    env: { ...env, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: string[] = [];
  const err: string[] = [];
  let buf = "";
  proc.stdout.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    out.push(...lines.filter(Boolean));
  });
  proc.stderr.on("data", (b: Buffer) =>
    err.push(...b.toString("utf8").split("\n").filter(Boolean)),
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
    (resolve) => {
      proc.on("exit", (code, signal) => {
        resolve({ code, signal, at: Date.now() });
      });
    },
  );
  return { proc, out, err, exited };
}

const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "p", version: "0" },
  },
});

/** Starts a server and completes the initialize handshake; returns the startup time. */
async function ready(): Promise<{ c: Child; startupMs: number }> {
  const t0 = Date.now();
  const c = start();
  c.proc.stdin.write(`${INIT}\n`);
  await waitFor(() => c.out.length >= 1, 20_000);
  return { c, startupMs: Date.now() - t0 };
}

describe("ff serve as a child process", () => {
  it("stdin EOF → exit 0 within 1 s; stdout carried only JSON-RPC", async () => {
    const { c, startupMs } = await ready();
    c.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    c.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    c.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ff_get_status", arguments: {} } })}\n`,
    );
    await waitFor(() => c.out.length >= 3, 20_000);
    const eof = Date.now();
    c.proc.stdin.end();
    const exit = await c.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - eof).toBeLessThan(1000);
    for (const l of c.out) {
      const m = JSON.parse(l) as { jsonrpc: string };
      expect(m.jsonrpc).toBe("2.0");
    }
    const status = JSON.parse(c.out[2] ?? "{}") as { result: { isError?: boolean } };
    expect(status.result.isError).not.toBe(true);
    for (const l of c.err) expect(() => JSON.parse(l) as unknown).not.toThrow();
    // A13's < 1 s startup is measured on dist by the latency suite; through tsx it is reported only
    console.log(`SERVE-STARTUP-MS ${String(startupMs)}`);
  }, 40_000);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s → exit 0",
    async (sig) => {
      const { c } = await ready();
      c.proc.kill(sig);
      const exit = await c.exited;
      expect(exit.code).toBe(0);
      expect(c.err.join("\n")).toContain('"event":"serve.shutdown"');
    },
    40_000,
  );

  it("invalid config → exit 2 with nothing on stdout", async () => {
    const c = start({ FF_TOOLSET: "bogus" });
    c.proc.stdin.end();
    const exit = await c.exited;
    expect(exit.code).toBe(2);
    expect(c.out).toEqual([]);
    expect(c.err.join("\n")).toContain("config.invalid");
  }, 40_000);
});
