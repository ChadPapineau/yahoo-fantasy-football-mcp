// serve-entry.mjs — the spawn target of tests/process/serve.test.ts: runs `ff serve` from source
// (loaded through tsx, `node --import tsx`) with the real process streams, then exits with its code
// (plan 05 §4.2 lifecycle tests; the CLI entry src/cli.ts does the same for the built package).
import { serve } from "../../../src/cli/serve.ts";

// test seam (never set by the CLI): a slowed close sequence, so a second SIGINT arrives while the
// first one's close is still running (the forced-exit path — QA-1-058)
const delay = process.env.FF_TEST_CLOSE_DELAY_MS;
const code = await serve(
  {
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  delay === undefined ? {} : { closeDelayMs: Number(delay) },
);
process.exit(code);
