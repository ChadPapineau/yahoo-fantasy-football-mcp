// lock-holder.mjs — a SECOND process that holds the store's writer lock (plan 05 §2 `store`,
// §4.1 row "SQLite write lock held 3 s by another process"): BEGIN IMMEDIATE, print LOCKED, block
// for <holdMs> with Atomics.wait (the lock stays held the whole time), COMMIT, print RELEASED.
// Usage: node lock-holder.mjs <db path> <holdMs>
import { DatabaseSync } from "node:sqlite";

const [file, holdArg] = process.argv.slice(2);
if (file === undefined || holdArg === undefined) {
  process.stderr.write("usage: lock-holder.mjs <db> <holdMs>\n");
  process.exit(2);
}
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("BEGIN IMMEDIATE");
db.exec("CREATE TEMP TABLE IF NOT EXISTS held (x INTEGER)");
db.exec(
  "INSERT INTO limiter_state (client_key, last999) VALUES ('lock-holder', '2026-09-30T00:00:00.000Z') ON CONFLICT (client_key) DO UPDATE SET last999 = excluded.last999",
);
process.stdout.write("LOCKED\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdArg));
db.exec("COMMIT");
db.close();
process.stdout.write("RELEASED\n");
