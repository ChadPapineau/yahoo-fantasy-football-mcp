// run-lock.ts — the run-start lock of a dataset refresh (`refresh:<source>` in job_lock) and its
// read-only view. A refresh takes the lock BEFORE its first request (the release check), so two
// processes refreshing one source never both download it: the second sees the lock and skips with
// zero requests (the publisher's own `publish:<source>` lock still guards the commit). A lock older
// than RUN_LOCK_STALE_MS or held by a dead pid is broken. job_lock is keyed by pid, so the lock also
// tracks the sources held by THIS process, refusing a second concurrent run inside one process too.
import { isDatasetSourceId, type DatasetSourceId } from "../config/freshness.js";
import type { RunLockReader } from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import { pidAlive } from "./lock.js";
import type { RepoDeps } from "./repos/common.js";
import type { JobLockRepository } from "./types.js";

/** A run lock older than this is stale (a refresh's own deadline is far shorter). */
export const RUN_LOCK_STALE_MS = 15 * 60_000;
/** The job lock name of a source's run. */
export const runLockJob = (source: DatasetSourceId): string => `refresh:${source}`;

/** The lock a refresh run takes (src/sources/runner.ts `RefreshDeps.runLock`). */
export interface RunLock {
  /** Resolves true when this run now holds `refresh:<source>`. */
  acquire(source: DatasetSourceId): Promise<boolean>;
  /** Releases it (only when this run holds it); never throws. */
  release(source: DatasetSourceId): Promise<void>;
}

/** Locks held by run locks of THIS process, per store (job_lock cannot tell them apart). */
const heldInProcess = new Set<string>();

/** A RunLock over a store's job_lock repository. */
export function createRunLock(o: {
  readonly jobLock: JobLockRepository;
  readonly clock: Clock;
  readonly pid: number;
  /** Distinguishes stores in one process (the store path). */
  readonly scope: string;
}): RunLock {
  const mine = new Set<DatasetSourceId>();
  return {
    async acquire(source) {
      const key = `${o.scope}|${runLockJob(source)}`;
      if (heldInProcess.has(key)) return false;
      heldInProcess.add(key);
      let ok = false;
      try {
        ok = await o.jobLock.acquire(
          runLockJob(source),
          o.pid,
          o.clock.nowIso(),
          RUN_LOCK_STALE_MS,
        );
      } finally {
        if (!ok) heldInProcess.delete(key);
      }
      if (ok) mine.add(source);
      return ok;
    },
    async release(source) {
      if (!mine.has(source)) return;
      mine.delete(source);
      heldInProcess.delete(`${o.scope}|${runLockJob(source)}`);
      try {
        await o.jobLock.release(runLockJob(source), o.pid);
      } catch {
        // a lock we could not release goes stale after RUN_LOCK_STALE_MS / when we exit
      }
    },
  };
}

/**
 * The read-only view the server uses: another process's `refresh:<source>` lock, when its pid is
 * alive and it is younger than RUN_LOCK_STALE_MS; null otherwise.
 */
export function runLockReader(deps: RepoDeps, clock: Clock, ownPid: number): RunLockReader {
  return {
    held(source) {
      if (!isDatasetSourceId(source)) throw new RangeError("store: unknown dataset source");
      const r = deps.db
        .prepare("SELECT pid, acquired_at, acquired_ms FROM job_lock WHERE job = ?")
        .get(runLockJob(source)) as
        { pid: number; acquired_at: string; acquired_ms: number } | undefined;
      if (r === undefined || r.pid === ownPid) return null;
      const age = clock.nowMs() - r.acquired_ms;
      if (age > RUN_LOCK_STALE_MS || !pidAlive(r.pid)) return null;
      return { pid: r.pid, acquired_at: r.acquired_at };
    },
  };
}
