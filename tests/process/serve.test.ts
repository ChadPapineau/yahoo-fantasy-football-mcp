// serve.test.ts — `ff serve` as a real child process (plan 05 §4.2; plan 03 §1.3; plan 10 A13):
// stdin EOF → exit 0 within 1 s, SIGTERM and SIGINT → exit 0, bad config → exit 2 with nothing on
// stdout, and nothing but JSON-RPC ever on stdout. Spawns `node --import tsx` on a TS-free entry
// (tests/process/fixtures/serve-entry.mjs) over the fixture league; no network, temp dirs only.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
/** Every server started by a test, killed afterwards if a failed test left it running. */
const started: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const p of started.splice(0))
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

function start(extra: Record<string, string> = {}): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    cwd: ROOT,
    env: { ...env, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(proc);
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
async function ready(extra: Record<string, string> = {}): Promise<{ c: Child; startupMs: number }> {
  const t0 = Date.now();
  const c = start(extra);
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

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
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

// plan 05 §4.2's remaining lifecycle cases (QA-1-058), plus the oversized frame (QA-1-077/090) and a
// store from a newer version (QA-1-051/099)
describe("ff serve lifecycle edges (plan 05 §4.2)", () => {
  it("SIGINT twice → forced exit 5 within 10 s", async () => {
    // the close sequence is held 8 s, so the second SIGINT lands while the first is closing
    const { c } = await ready({ FF_TEST_CLOSE_DELAY_MS: "8000" });
    c.proc.kill("SIGINT");
    await waitFor(() => c.err.some((l) => l.includes('"event":"serve.shutdown"')), 5000);
    const t = Date.now();
    c.proc.kill("SIGINT");
    const exit = await c.exited;
    expect(exit.code).toBe(5);
    expect(exit.at - t).toBeLessThan(10_000);
    expect(c.err.join("\n")).toContain('"reason":"second_sigint"');
  }, 40_000);

  it("stdout reader closed → exit 0 (EPIPE path)", async () => {
    const { c } = await ready();
    c.proc.stdout.destroy();
    c.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    c.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const exit = await c.exited;
    expect(exit.code).toBe(0);
    expect(c.err.join("\n")).toMatch(/"reason":"(epipe|stdout_error)"/);
  }, 40_000);

  it("a line over 10 MiB → the clean close sequence and exit 1, never 13", async () => {
    const { c } = await ready();
    c.proc.stdin.write(
      `{"jsonrpc":"2.0","id":2,"method":"ping","params":{"x":"${"a".repeat(10 * 1024 * 1024 + 16)}"}}\n`,
    );
    const exit = await c.exited;
    expect(exit.code).toBe(1);
    expect(c.err.join("\n")).toContain('"reason":"transport_closed"');
  }, 40_000);

  it("a store from version + 1 → exit 1 with plan 03 §7's message", async () => {
    const first = start();
    first.proc.stdin.end();
    expect((await first.exited).code).toBe(0);
    const db = new DatabaseSync(path.join(root, "cache", "store.sqlite"));
    const v = (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      v + 1,
      "2030-01-01T00:00:00.000Z",
    );
    db.close();
    const c = start();
    c.proc.stdin.end();
    const exit = await c.exited;
    expect(exit.code).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err.join("\n")).toContain(
      `store.sqlite was written by a newer version (v${String(v + 1)}); this binary supports v${String(v)}. Upgrade the package or restore the backup.`,
    );
  }, 40_000);

  it("parent SIGKILLed (stdin held open by a sibling) → the orphan exits within 10 s", async () => {
    const errFile = path.join(root, "orphan-stderr.log");
    const parent = spawn(
      process.execPath,
      [path.join(ROOT, "tests", "process", "fixtures", "orphan-parent.mjs"), ENTRY, errFile],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "ignore"] },
    );
    let line = "";
    parent.stdout.on("data", (b: Buffer) => (line += b.toString("utf8")));
    await waitFor(() => line.includes("\n"), 20_000);
    const { child, sibling } = JSON.parse(line) as { child: number; sibling: number };
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // the server is up (its ready line is in the file) before the parent dies
      await waitFor(
        () => existsSync(errFile) && readFileSync(errFile, "utf8").includes("serve.ready"),
        20_000,
      );
      parent.kill("SIGKILL");
      const t = Date.now();
      await waitFor(() => !alive(child), 10_000);
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(readFileSync(errFile, "utf8")).toContain('"reason":"orphaned"');
      expect(alive(sibling)).toBe(true); // control: stdin stayed open — not the EOF path
    } finally {
      for (const pid of [child, sibling]) if (alive(pid)) process.kill(pid, "SIGKILL");
      if (alive(parent.pid ?? -1)) parent.kill("SIGKILL");
    }
  }, 60_000);
});
