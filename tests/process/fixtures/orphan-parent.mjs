// orphan-parent.mjs — a parent for the orphan test (tests/process/serve.test.ts, QA-1-058; plan 03
// §1.3 A-3): spawns `ff serve` (serve-entry.mjs) with its stdin on a pipe, hands that pipe's write
// end to a detached sibling that outlives this process (so the server never sees stdin EOF), sends
// the server's stderr to a file, prints both pids, then waits to be SIGKILLed.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const [entry, errFile] = process.argv.slice(2);
const err = openSync(errFile, "a", 0o600);
const child = spawn(process.execPath, ["--import", "tsx", entry], {
  env: process.env,
  stdio: ["pipe", "ignore", err],
});
const sibling = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", child.stdin],
});
sibling.unref();
process.stdout.write(`${JSON.stringify({ child: child.pid, sibling: sibling.pid })}\n`);
setInterval(() => {}, 1000);
