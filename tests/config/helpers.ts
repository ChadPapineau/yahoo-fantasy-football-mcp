// helpers.ts — temp directories for the config tests (real filesystem: the path rules are about
// real modes, symlinks and realpaths, so they are tested against real files, not mocks).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The repository root (the checkout the config must stay out of). */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A fresh real-path temp dir (macOS /var → /private/var resolved) with a cleanup function. */
export function tempDir(prefix = "ff-config-"): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
