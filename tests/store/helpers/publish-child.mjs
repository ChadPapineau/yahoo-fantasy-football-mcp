// publish-child.mjs — a separate `ff refresh`-role process publishing nflverse:injuries through the
// real DatasetPublisher (run with `node --import tsx` so it imports src/store directly). Modes:
//   ok    — fill, hold, return stats (two-process contention: the overlap window)
//   crash — fill, then SIGKILL itself mid-publish (torn-publish test: the old file must survive)
// <hold> is how long the fill keeps the job lock after FILLING: a number of ms, or `release` — hold
// until a `release` line arrives on stdin (QA-2-065: the test releases A only after B has made its
// attempt; a fixed hold raced B's process start-up). A `release` hold is bounded: with no release
// line within <releaseTimeoutMs> (default 60 000), or stdin closed without one, the child writes why
// to stderr and exits 3 without publishing — a broken run fails fast instead of hanging.
// <startDelayMs> (default 0) delays the start, before the publisher opens: a slow process start.
// Prints FILLING when the staging file holds rows, then the PublishOutcome as JSON.
// Usage: node --import tsx publish-child.mjs <storePath> <datasetDir> <mode> <version> <hold>
//          [startDelayMs] [releaseTimeoutMs]
import { fixedClock } from "../../../src/domain/clock.js";
import { DS_INJURIES } from "../../../src/store/datasets/tables.js";
import { createStoreFactory } from "../../../src/store/index.js";

const [storePath, datasetDir, mode, version, hold, startDelayMs = "0", releaseTimeoutMs = "60000"] =
  process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves on a `release` line on stdin; exits 3 on the bound or on stdin closing without one. */
function releaseLine(boundMs) {
  return new Promise((resolve) => {
    let buf = "";
    let released = false;
    const giveUp = (why) => {
      if (released) return;
      process.stderr.write(`publish-child: ${why}; not publishing\n`);
      process.exit(3);
    };
    const timer = setTimeout(() => giveUp(`no release line within ${String(boundMs)} ms`), boundMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      if (!buf.split("\n").some((l) => l.trim() === "release")) return;
      released = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve();
    });
    process.stdin.on("end", () => giveUp("stdin closed without a release line"));
  });
}

if (Number(startDelayMs) > 0) await sleep(Number(startDelayMs));
const pub = createStoreFactory().openPublisher({
  storePath,
  datasetDir,
  clock: fixedClock("2026-09-30T12:00:00.000Z"),
});
const rows = Array.from({ length: 50 }, (_, i) => {
  const r = {};
  for (const c of DS_INJURIES.columns) r[c.name] = null;
  return Object.assign(r, {
    season: 2026,
    game_type: "REG",
    week: 3,
    team: "BUF",
    gsis_id: `00-${String(9_000_000 + i)}`,
    full_name: `child ${version}`,
  });
});
const out = await pub.publish("nflverse:injuries", version, null, async (w) => {
  w.createTable(DS_INJURIES);
  w.insert("ds_injuries", rows);
  process.stdout.write(`FILLING ${w.path}\n`);
  if (mode === "crash") process.kill(process.pid, "SIGKILL");
  if (hold === "release") await releaseLine(Number(releaseTimeoutMs));
  else await sleep(Number(hold));
  return {
    rows: rows.length,
    tables: [{ name: "ds_injuries", rows: rows.length }],
    seasons: [2026],
    columns_hash: "child",
  };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
pub.close();
