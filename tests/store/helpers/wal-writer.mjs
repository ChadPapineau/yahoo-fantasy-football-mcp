// wal-writer.mjs — a SECOND server process writing the store with checkpoints disabled, so its
// committed rows live only in store.sqlite-wal (plan 03 L7 / OBJ-10: a file copy would miss them).
//   fixed  <nLog> <nJournal> — commit that many recommendation_log / write_journal rows, print
//                              READY, then keep the connection open until stdin closes
//   stream <batch>           — commit transactions of <batch> log rows back to back, printing
//                              STARTED after the first; stops when stdin closes, prints DONE <total>
// Usage: node wal-writer.mjs <db path> fixed <nLog> <nJournal> | stream <batch>
import { DatabaseSync } from "node:sqlite";

const [file, mode, a, b] = process.argv.slice(2);
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("PRAGMA wal_autocheckpoint = 0");
const ins = db.prepare(
  `INSERT INTO recommendation_log (log_id, league_key, season, week, kind, recorded_at, recorded_ms, settings_hash, client_ref, record_json)
   VALUES (?, 'manual.l.example', 2026, 4, 'lineup', '2026-09-30T12:00:00.000Z', 0, NULL, NULL, '{}')`,
);
const jins = db.prepare(
  `INSERT INTO write_journal (journal_id, status, created_at, created_ms, updated_at, payload_json)
   VALUES (?, 'prepared', '2026-09-30T12:00:00.000Z', 0, '2026-09-30T12:00:00.000Z', '{}')`,
);
let seq = 0;
const logId = () =>
  `rec-W${String(process.pid).padStart(9, "0")}${String(seq++).padStart(16, "0")}`;
let stop = false;
process.stdin.on("end", () => {
  stop = true;
});
process.stdin.on("close", () => {
  stop = true;
});
process.stdin.resume();

if (mode === "fixed") {
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < Number(a); i++) ins.run(logId());
  for (let i = 0; i < Number(b); i++) jins.run(`j-${String(process.pid)}-${String(i)}`);
  db.exec("COMMIT");
  process.stdout.write("READY\n");
  const wait = () => (stop ? process.exit(0) : setTimeout(wait, 20));
  wait();
} else {
  let total = 0;
  const batch = Number(a);
  const step = () => {
    if (stop) {
      process.stdout.write(`DONE ${String(total)}\n`);
      process.exit(0);
    }
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < batch; i++) ins.run(logId());
    db.exec("COMMIT");
    total += batch;
    if (total === batch) process.stdout.write("STARTED\n");
    setImmediate(step);
  };
  step();
}
