// serve-on-demand-entry.mjs — the spawn target of tests/process/serve-on-demand.test.ts: runs
// `ff serve` from source (through tsx) with the answer-time refresh child pointed at a test script
// (FF_TEST_CHILD_ENTRY, run by plain `node`), so the shutdown path can be watched with a child that
// never finishes. Test seam only: the CLI never sets `internals.onDemand`.
import { serve } from "../../../src/cli/serve.ts";

const entry = process.env.FF_TEST_CHILD_ENTRY;
const code = await serve(
  {
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  entry === undefined ? {} : { onDemand: { entry, execArgv: [] } },
);
process.exit(code);
