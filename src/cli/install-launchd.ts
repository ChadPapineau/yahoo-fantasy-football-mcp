// install-launchd.ts — `ff install-launchd [--jobs a,b] [--dry-run]` (plan 06 J1, §2; plan 03 L4):
// generates one LaunchAgent plist per job with absolute paths and installs it with `launchctl
// bootstrap gui/<uid>` (after a `bootout`, so re-running replaces a loaded job). `--dry-run` prints
// the plists and the launchctl commands and changes nothing — it works on any platform.
import type { Config } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, write, writeLine, type CliIo } from "./io.js";
import {
  installJobs,
  jobEnv,
  JOBS,
  LAUNCHCTL,
  labelOf,
  launchctl,
  plistPath,
  renderPlist,
  selectJobs,
  type LaunchdJob,
} from "./launchd.js";
import { existsSync } from "node:fs";

/** The jobs to install: `--jobs`, else every job (weather dropped when FF_WEATHER_SOURCE=off). */
export function jobsFor(spec: string | undefined, config: Config): LaunchdJob[] {
  let jobs: LaunchdJob[];
  try {
    jobs = selectJobs(spec);
  } catch (e) {
    throw new UsageError(
      `--jobs: ${(e as Error).message}; known: ${JOBS.map((j) => j.name).join(", ")}`,
    );
  }
  if (spec === undefined && config.weatherSource === "off")
    jobs = jobs.filter((j) => j.name !== "weather");
  return jobs;
}

/** `ff install-launchd`. */
export async function installLaunchd(
  io: CliIo,
  config: Config,
  opts: { readonly jobs: string | undefined; readonly dryRun: boolean },
): Promise<number> {
  const jobs = jobsFor(opts.jobs, config);
  const entry = distEntry(io.packageRoot);
  const env = jobEnv(config);
  if (opts.dryRun) {
    if (!existsSync(entry))
      await writeLine(
        io.stderr,
        `ff install-launchd: warning: ${entry} does not exist yet — run \`npm run build\` before installing`,
      );
    const uid = io.uid ?? 501;
    for (const job of jobs) {
      const file = plistPath(io.home, job);
      await writeLine(io.stdout, `# ${file} — ${job.description}`);
      await write(io.stdout, renderPlist({ job, node: io.execPath, entry, env, home: io.home }));
      await writeLine(
        io.stdout,
        `# would run: ${LAUNCHCTL} ${launchctl.bootout(uid, labelOf(job)).join(" ")}`,
      );
      await writeLine(
        io.stdout,
        `# would run: ${LAUNCHCTL} ${launchctl.bootstrap(uid, file).join(" ")}`,
      );
      await writeLine(io.stdout, "");
    }
    await writeLine(
      io.stderr,
      `ff install-launchd: dry run — ${String(jobs.length)} job(s), nothing written`,
    );
    return EXIT.OK;
  }
  if (io.platform !== "darwin") {
    await writeLine(
      io.stderr,
      "ff install-launchd: launchd is macOS-only (use --dry-run to see the plists, or schedule `ff refresh` with your platform's scheduler)",
    );
    return EXIT.USAGE;
  }
  if (io.uid === null) {
    await writeLine(io.stderr, "ff install-launchd: no user id available");
    return EXIT.ERROR;
  }
  if (!existsSync(entry)) {
    await writeLine(
      io.stderr,
      `ff install-launchd: ${entry} does not exist — run \`npm run build\` first`,
    );
    return EXIT.ERROR;
  }
  const steps = await installJobs({
    jobs,
    home: io.home,
    node: io.execPath,
    entry,
    env,
    uid: io.uid,
    exec: io.exec,
  });
  let failed = 0;
  for (const s of steps) {
    if (!s.ok) failed++;
    await writeLine(
      io.stdout,
      `${s.ok ? "ok  " : "FAIL"} ${s.kind} ${s.detail}${s.ok ? "" : ` (launchctl exit ${String(s.code ?? "killed")})`}`,
    );
  }
  await writeLine(
    io.stdout,
    failed === 0
      ? `installed ${String(jobs.length)} job(s); \`ff doctor\` verifies they are loaded`
      : `${String(failed)} job(s) failed to load`,
  );
  return failed === 0 ? EXIT.OK : EXIT.ERROR;
}
