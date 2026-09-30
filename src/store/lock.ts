// lock.ts — the process-wide store lock (plan 03 §7 / L7: backups and migrations run "while holding
// the process-wide lock", the token-lock pattern of plan 02 §3.3): `<store>.lock` created `wx`
// (exclusive, O_NOFOLLOW) holding `pid` and the ISO time; stale after STALE_LOCK_MS or when its pid
// is dead, then broken. Waits are bounded; the sync form (startup migrations) sleeps with
// Atomics.wait, the async form yields to the event loop.
import {
  closeSync,
  constants as fsc,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** A lock older than this is considered abandoned (plan 02 §3.3: 30 s). */
export const STALE_LOCK_MS = 30_000;
/** How long an acquirer waits before giving up. */
export const LOCK_WAIT_MS = 5_000;
const POLL_MS = 25;

/** The store lock could not be taken within the wait budget. */
export class StoreLockTimeoutError extends Error {
  readonly ffCode = "STORE_BUSY" as const;
  constructor(readonly lockPath: string) {
    super("store: the process-wide store lock is held by another process");
    this.name = "StoreLockTimeoutError";
  }
}

/** Whether `pid` names a live process (EPERM = alive but not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(lockPath: string, nowIso: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${String(process.pid)} ${nowIso}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Breaks the lock when its holder is dead or it is older than STALE_LOCK_MS; true when broken. */
function breakIfStale(lockPath: string, nowMs: number): boolean {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lockPath, { encoding: "utf8", flag: fsc.O_RDONLY | fsc.O_NOFOLLOW });
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ELOOP") {
      rmSync(lockPath, { force: true });
      return true;
    }
    throw e;
  }
  const pid = Number.parseInt(text.split(" ")[0] ?? "", 10);
  const alive = pidAlive(pid);
  if (!alive || nowMs - mtimeMs > STALE_LOCK_MS) {
    rmSync(lockPath, { force: true });
    return true;
  }
  return false;
}

/** A held lock. */
export interface HeldLock {
  release(): void;
}

function held(lockPath: string): HeldLock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}

const sab = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sab, 0, 0, ms);
}

/** Takes the lock, waiting (blocking) at most `waitMs`. For startup only. */
export function acquireLockSync(lockPath: string, waitMs = LOCK_WAIT_MS): HeldLock {
  const start = Date.now();
  for (;;) {
    if (tryCreate(lockPath, new Date().toISOString())) return held(lockPath);
    if (breakIfStale(lockPath, Date.now())) continue;
    if (Date.now() - start >= waitMs) throw new StoreLockTimeoutError(lockPath);
    sleepSync(POLL_MS);
  }
}

/** Takes the lock, yielding between attempts, for at most `waitMs`. */
export async function acquireLock(lockPath: string, waitMs = LOCK_WAIT_MS): Promise<HeldLock> {
  const start = Date.now();
  for (;;) {
    if (tryCreate(lockPath, new Date().toISOString())) return held(lockPath);
    if (breakIfStale(lockPath, Date.now())) continue;
    if (Date.now() - start >= waitMs) throw new StoreLockTimeoutError(lockPath);
    await sleep(POLL_MS);
  }
}
