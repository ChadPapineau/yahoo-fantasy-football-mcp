// exit.ts — the `ff` exit codes, shared by every subcommand (plan 03 §1.3 "Exit codes (shared with
// the CLI)", §5 "exit code = worst finding (0 ok, 1 fail, 2 config)").

/**
 * Process exit codes. `serve` may also return 5 (forced shutdown after the drain deadline); 3 and 4
 * (not authenticated / not provisioned) belong to the Yahoo provider, which this build does not
 * ship (Phase 1b deferred), so no 1a subcommand returns them.
 */
export const EXIT = Object.freeze({
  /** Success (a refresh that published, found nothing new, or skipped). */
  OK: 0,
  /** A failure: a refresh failed, a doctor row failed, the store could not be opened. */
  ERROR: 1,
  /** Usage or configuration: an unknown flag, a relative path, an invalid FF_* value. */
  USAGE: 2,
  /** Not authenticated (Yahoo; unused in this build). */
  NOT_AUTHENTICATED: 3,
  /** Not provisioned (Yahoo; unused in this build). */
  NOT_PROVISIONED: 4,
  /** `serve` forced its shutdown after the close deadline. */
  FORCED: 5,
});

/** An exit code. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A usage error: printed as one stderr line plus a pointer to `ff help`, exit 2. */
export class UsageError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
