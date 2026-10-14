// install-launchd.ts — `ff install-launchd [--jobs a,b] [--dry-run]` (plan 06 J1, §2; plan 03 L4):
// generates one LaunchAgent plist per job with absolute paths and installs it with `launchctl
// bootstrap gui/<uid>` (after a `bootout`, so re-running replaces a loaded job). Once the refresh
// tick is loaded, the plists of the jobs it replaced (RETIRED_JOB_NAMES) are booted out and removed,
// so an upgrade needs this one command. `--dry-run` prints the plists, the launchctl commands and
// what would be retired, and changes nothing — it works on any platform.
import type { Config } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, write, writeLine, type CliIo } from "./io.js";
import {
  installedPlists,
  installJobs,
  jobEnv,
  JOBS,
  REFRESH_DUE_JOB,
  retireJobs,
  LAUNCHCTL,
  labelOf,
  launchctl,
  plistPath,
  renderPlist,
  selectJobs,
  type LaunchdJob,
} from "./launchd.js";
import { existsSync } from "node:fs";

/**
 * The jobs to install: `--jobs`, else every job. A retired job name (an earlier version's per-source
 * job) is a usage error naming `refresh-due`, which replaced it. FF_WEATHER_SOURCE=off needs no job
 * change: the tick skips weather itself.
 */
export function jobsFor(spec: string | undefined): LaunchdJob[] {
  try {
    return selectJobs(spec);
  } catch (e) {
    throw new UsageError(
      `--jobs: ${(e as Error).message}; known: ${JOBS.map((j) => j.name).join(", ")}`,
    );
  }
}

/** `ff install-launchd`. */
export async function installLaunchd(
  io: CliIo,
  config: Config,
  opts: { readonly jobs: string | undefined; readonly dryRun: boolean },
): Promise<number> {
  const jobs = jobsFor(opts.jobs);
  // the retired per-source jobs are replaced by the tick: retire them only when it is installed
  const retiring = jobs.some((j) => j.name === REFRESH_DUE_JOB);
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
    if (retiring)
      for (const s of await retireJobs({ home: io.home, uid, exec: io.exec, dryRun: true }))
        await writeLine(
          io.stdout,
          s.ok
            ? `# would retire ${s.detail} (bootout, then remove its plist)`
            : `# would refuse to retire ${s.detail}: its plist is a symlink`,
        );
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
  let refused = 0;
  if (retiring && failed === 0) {
    for (const s of await retireJobs({
      home: io.home,
      uid: io.uid,
      exec: io.exec,
      dryRun: false,
    })) {
      if (!s.ok) refused++;
      await writeLine(io.stdout, s.ok ? `retired ${s.detail}` : `FAIL retire ${s.detail}`);
    }
  } else if (retiring && installedPlists(io.home).some((p) => p.retired)) {
    await writeLine(
      io.stdout,
      "kept the earlier version's jobs: the new ones did not all load (re-run after fixing it)",
    );
  }
  await writeLine(
    io.stdout,
    failed === 0
      ? `installed ${String(jobs.length)} job(s); \`ff doctor\` verifies they are loaded`
      : `${String(failed)} job(s) failed to load`,
  );
  return failed === 0 && refused === 0 ? EXIT.OK : EXIT.ERROR;
}
