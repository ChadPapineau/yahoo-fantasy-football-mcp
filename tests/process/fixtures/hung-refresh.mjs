// hung-refresh.mjs — a stand-in `ff refresh --on-demand` child that never finishes (the server's
// shutdown must SIGTERM it): it records its pid and argv beside the cache, then idles. It inherits
// only the server's child environment allow-list, so FF_CACHE_DIR is where it writes.
import { writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FF_CACHE_DIR;
if (dir !== undefined) {
  writeFileSync(
    path.join(dir, "hung-child.json"),
    JSON.stringify({
      pid: process.pid,
      argv: process.argv.slice(2),
      env: Object.keys(process.env),
    }),
  );
}
process.on("SIGTERM", () => {
  if (dir !== undefined) writeFileSync(path.join(dir, "hung-child.sigterm"), String(process.pid));
  process.exit(143);
});
setInterval(() => undefined, 1000);
