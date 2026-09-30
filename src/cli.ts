#!/usr/bin/env node
// cli.ts — the `ff` process entry (plan 01 §10; plan 03 §1.1–§1.3): hands argv and the real process
// io to src/cli/main.ts and exits with its code once output is flushed. For every subcommand except
// `serve` (which installs its own shutdown handlers, plan 03 §1.3), SIGINT/SIGTERM abort a running
// refresh cleanly. Excluded from coverage (plan 05 §7: arg dispatch); the logic is in src/cli/.
import { defaultIo } from "./cli/io.js";
import { main } from "./cli/main.js";

const argv = process.argv.slice(2);
const controller = new AbortController();
if (argv[0] !== "serve") {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      controller.abort();
    });
  }
}
const code = await main(argv, defaultIo(), { signal: controller.signal });
process.exit(code);
