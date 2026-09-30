// publish-child.mjs — a separate `ff refresh`-role process publishing nflverse:injuries through the
// real DatasetPublisher (run with `node --import tsx` so it imports src/store directly). Modes:
//   ok    — fill, wait <holdMs>, return stats (two-process contention: the overlap window)
//   crash — fill, then SIGKILL itself mid-publish (torn-publish test: the old file must survive)
// Prints FILLING when the staging file holds rows, then the PublishOutcome as JSON.
// Usage: node --import tsx publish-child.mjs <storePath> <datasetDir> <mode> <version> <holdMs>
import { fixedClock } from "../../../src/domain/clock.js";
import { DS_INJURIES } from "../../../src/store/datasets/tables.js";
import { createStoreFactory } from "../../../src/store/index.js";

const [storePath, datasetDir, mode, version, holdMs] = process.argv.slice(2);
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
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  return {
    rows: rows.length,
    tables: [{ name: "ds_injuries", rows: rows.length }],
    seasons: [2026],
    columns_hash: "child",
  };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
pub.close();
