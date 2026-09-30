// spawn.ts — child-process helpers for the multi-process store tests (argument arrays only; no
// shell). TS helpers run under `node --import tsx` so they can import src/store directly.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ROOT } from "./env.js";

export const HELPERS = path.join(ROOT, "tests", "store", "helpers");

export interface Child {
  readonly proc: ChildProcess;
  /** Resolves with the first stdout line matching `re` (rejects on exit or after `timeoutMs`). */
  waitFor(re: RegExp, timeoutMs?: number): Promise<string>;
  /** Resolves with the exit code (or the signal name). */
  exited(): Promise<number | string>;
  readonly out: string[];
  readonly err: string[];
}

export function run(helper: string, args: readonly string[], opts: { tsx?: boolean } = {}): Child {
  const nodeArgs =
    opts.tsx === true
      ? ["--import", "tsx", path.join(HELPERS, helper), ...args]
      : [path.join(HELPERS, helper), ...args];
  const proc = spawn(process.execPath, nodeArgs, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const out: string[] = [];
  const err: string[] = [];
  const waiters: { re: RegExp; resolve: (s: string) => void }[] = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    buf += d;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      out.push(line);
      for (const w of [...waiters])
        if (w.re.test(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(line);
        }
      nl = buf.indexOf("\n");
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => err.push(d));
  const exit = new Promise<number | string>((resolve) => {
    proc.on("exit", (code, signal) => {
      resolve(code ?? signal ?? "unknown");
    });
  });
  return {
    proc,
    out,
    err,
    exited: () => exit,
    waitFor(re, timeoutMs = 15_000) {
      const seen = out.find((l) => re.test(l));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timeout waiting for ${String(re)}; stderr: ${err.join("")}`));
        }, timeoutMs);
        void exit.then((c) => {
          clearTimeout(timer);
          reject(
            new Error(`child exited (${String(c)}) before ${String(re)}; stderr: ${err.join("")}`),
          );
        });
        waiters.push({
          re,
          resolve: (s) => {
            clearTimeout(timer);
            resolve(s);
          },
        });
      });
    },
  };
}
