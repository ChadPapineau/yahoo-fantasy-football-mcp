// notify.test.ts — plan 06 §2 notifications: osascript through the injected executor with an
// argument array, rate-limited to one failure notification per job per 6 h, fixed-vocabulary text.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appleScriptString,
  createNotifier,
  failureText,
  NOTIFY_RATE_LIMIT_MS,
  NOTIFY_STATE_FILE,
  OSASCRIPT,
} from "../../src/cli/notify.js";
import { fixedClock } from "../../src/domain/clock.js";
import { fakeExec, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

describe("createNotifier", () => {
  it("is a no-op off macOS (no exec)", async () => {
    sb = sandbox({ create: true });
    const fx = fakeExec();
    const n = createNotifier({
      platform: "linux",
      exec: fx.exec,
      clock: fixedClock(0),
      cacheDir: sb.cacheDir,
    });
    expect(await n.notifyFailure("weather", "network")).toBe("unsupported");
    expect(fx.calls).toEqual([]);
  });

  it("shows one notification via osascript -e, then rate-limits for 6 h per job", async () => {
    sb = sandbox({ create: true });
    const fx = fakeExec();
    const clock = fixedClock("2026-10-04T12:00:00Z");
    const n = createNotifier({ platform: "darwin", exec: fx.exec, clock, cacheDir: sb.cacheDir });
    expect(await n.notifyFailure("refresh-weather", "network")).toBe("shown");
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.file).toBe(OSASCRIPT);
    expect(fx.calls[0]?.args[0]).toBe("-e");
    expect(fx.calls[0]?.args[1]).toBe(
      'display notification "refresh-weather failed: network — run `ff status`" with title "fantasy-football-mcp"',
    );
    clock.advance(NOTIFY_RATE_LIMIT_MS - 1);
    expect(await n.notifyFailure("refresh-weather", "schema")).toBe("rate_limited");
    expect(await n.notifyFailure("store-backup", "backup")).toBe("shown");
    clock.advance(1);
    expect(await n.notifyFailure("refresh-weather", "schema")).toBe("shown");
    expect(fx.calls).toHaveLength(3);
    const statePath = path.join(sb.cacheDir, NOTIFY_STATE_FILE);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toHaveProperty("store-backup");
  });

  it("a clock that went backwards does not suppress forever", async () => {
    sb = sandbox({ create: true });
    const fx = fakeExec();
    const clock = fixedClock("2026-10-04T12:00:00Z");
    const n = createNotifier({ platform: "darwin", exec: fx.exec, clock, cacheDir: sb.cacheDir });
    await n.notifyFailure("j", "e");
    clock.advance(-10 * NOTIFY_RATE_LIMIT_MS);
    expect(await n.notifyFailure("j", "e")).toBe("shown");
  });

  it("a failing osascript is reported and not stamped", async () => {
    sb = sandbox({ create: true });
    const fx = fakeExec(() => ({ code: 1 }));
    const n = createNotifier({
      platform: "darwin",
      exec: fx.exec,
      clock: fixedClock(0),
      cacheDir: sb.cacheDir,
    });
    expect(await n.notifyFailure("j", "e")).toBe("failed");
    expect(await n.notifyFailure("j", "e")).toBe("failed");
    expect(fx.calls).toHaveLength(2);
  });

  it("tolerates a corrupt, hostile or unreadable state file", async () => {
    sb = sandbox({ create: true });
    const statePath = path.join(sb.cacheDir, NOTIFY_STATE_FILE);
    const fx = fakeExec();
    const n = createNotifier({
      platform: "darwin",
      exec: fx.exec,
      clock: fixedClock(1e12),
      cacheDir: sb.cacheDir,
    });
    for (const text of ["{nope", "[1,2]", '{"__proto__": 1, "j": "x", "k": 1e400}', "null"]) {
      writeFileSync(statePath, text, { mode: 0o600 });
      chmodSync(statePath, 0o600);
      expect(await n.notifyFailure("j", "e")).toBe("shown");
    }
    // a group-readable state file is not trusted (and not fatal)
    writeFileSync(statePath, "{}");
    chmodSync(statePath, 0o644);
    expect(await n.notifyFailure("j", "e")).toBe("shown");
  });

  it("a state file that cannot be written does not turn a shown notification into a failure", async () => {
    sb = sandbox({ create: true });
    const target = path.join(sb.dir, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, path.join(sb.cacheDir, NOTIFY_STATE_FILE));
    const fx = fakeExec();
    const n = createNotifier({
      platform: "darwin",
      exec: fx.exec,
      clock: fixedClock(0),
      cacheDir: sb.cacheDir,
    });
    expect(await n.notifyFailure("j", "e")).toBe("shown");
  });
});

describe("notification text", () => {
  it("is fixed vocabulary: hostile job/error strings are replaced, never echoed", () => {
    expect(failureText("weather", "network")).toBe("weather failed: network — run `ff status`");
    expect(failureText('x" & do shell script "rm -rf ~', "y")).toBe(
      "job failed: y — run `ff status`",
    );
    expect(failureText("j", "a b\nc")).toBe("j failed: error — run `ff status`");
    expect(failureText("j".repeat(65), "e")).toMatch(/^job failed/);
  });

  it("escapes AppleScript string literals", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});
