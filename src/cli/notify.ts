// notify.ts — the failure notification of a launchd job (plan 06 J2, §2 "Notifications: osascript
// … via execFile with an argument array; rate-limited per job to one per 6 h for failures"; §3 the
// macOS-notification channel). The text is server-authored from a fixed vocabulary (job name +
// error code) — never upstream text — and is passed to AppleScript as an escaped string literal in
// an argument array (no shell). Rate-limit state is a small 0600 JSON file in the cache dir.
import path from "node:path";
import { readSecureFile, writeSecureFileAtomic } from "../config/paths.js";
import type { Clock } from "../domain/clock.js";
import type { Exec } from "./io.js";

/** One failure notification per job per this many ms (plan 06 §2). */
export const NOTIFY_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;
/** The rate-limit state file inside the cache dir. */
export const NOTIFY_STATE_FILE = "notify-state.json";
/** The osascript binary (absolute: never resolved through PATH). */
export const OSASCRIPT = "/usr/bin/osascript";
/** Notification title. */
export const NOTIFY_TITLE = "fantasy-football-mcp";

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Escapes a string for an AppleScript double-quoted literal. */
export function appleScriptString(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The fixed-vocabulary notification text for a failed job. */
export function failureText(job: string, error: string): string {
  const j = CODE_RE.test(job) ? job : "job";
  const e = CODE_RE.test(error) ? error : "error";
  return `${j} failed: ${e} — run \`ff status\``;
}

/** A notifier. `notifyFailure` never throws and reports whether a notification was shown. */
export interface Notifier {
  notifyFailure(
    job: string,
    error: string,
  ): Promise<"shown" | "rate_limited" | "unsupported" | "failed">;
}

function readState(file: string): Record<string, number> {
  try {
    const text = readSecureFile(file, {
      requirePrivate: true,
      maxBytes: 64 * 1024,
      what: "notify state",
    });
    if (text === null) return {};
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (CODE_RE.test(k) && typeof n === "number" && Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Builds a notifier over osascript (darwin only) with a per-job rate limit in `<cache>/notify-state.json`. */
export function createNotifier(opts: {
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly clock: Clock;
  readonly cacheDir: string;
}): Notifier {
  const file = path.join(opts.cacheDir, NOTIFY_STATE_FILE);
  return {
    async notifyFailure(job, error) {
      if (opts.platform !== "darwin") return "unsupported";
      const now = opts.clock.nowMs();
      const state = readState(file);
      const key = CODE_RE.test(job) ? job : "job";
      const last = state[key];
      if (last !== undefined && now - last < NOTIFY_RATE_LIMIT_MS && now >= last)
        return "rate_limited";
      const script = `display notification ${appleScriptString(failureText(job, error))} with title ${appleScriptString(NOTIFY_TITLE)}`;
      const r = await opts.exec(OSASCRIPT, ["-e", script], { timeoutMs: 5_000 });
      if (r.code !== 0) return "failed";
      try {
        writeSecureFileAtomic(file, JSON.stringify({ ...state, [key]: now }), "notify state");
      } catch {
        // the notification was shown; a lost rate-limit stamp only means a possible repeat
      }
      return "shown";
    },
  };
}
