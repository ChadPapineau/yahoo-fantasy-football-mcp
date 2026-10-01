// io.test.ts — the CLI's process seams: the executor (execFile, argument array, bounded time; never
// a shell), flushed writes, the boot log level, and a runtime whose logger already redacts secrets.
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootLevel,
  defaultExec,
  defaultIo,
  distEntry,
  loadRuntime,
  tolerateClosedPipe,
  write,
} from "../../src/cli/io.js";
import { EXIT } from "../../src/cli/exit.js";
import { main } from "../../src/cli/main.js";
import { errorText, openExistingStore, storeWeatherSource } from "../../src/cli/store-access.js";
import { PathSecurityError } from "../../src/config/paths.js";
import { loadConfig } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import { makeIo, ROOT, sandbox, type Sandbox } from "./helpers.js";
import { makeLogger } from "../../src/cli/io.js";
import { writeFileSync, mkdirSync } from "node:fs";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

describe("defaultExec", () => {
  it("returns exit codes and output; a shell metacharacter is an argument, not a command", async () => {
    const r = await defaultExec(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1] ?? ''); process.exit(3)",
      "a;echo pwned",
    ]);
    expect(r).toEqual({ code: 3, stdout: "a;echo pwned", stderr: "" });
    const ok = await defaultExec(process.execPath, ["-e", "0"]);
    expect(ok.code).toBe(0);
  });

  it("a missing binary or a timeout is a result with code null, never a throw", async () => {
    expect((await defaultExec("/nonexistent/binary", [])).code).toBeNull();
    const slow = await defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 100,
    });
    expect(slow.code).toBeNull();
  });
});

describe("io helpers", () => {
  it("write resolves after the stream accepted the text, and survives a throwing stream", async () => {
    const chunks: string[] = [];
    const ok = new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    await write(ok, "hello");
    expect(chunks).toEqual(["hello"]);
    const bad = {
      write: () => {
        throw new Error("EPIPE");
      },
    } as unknown as NodeJS.WritableStream;
    await expect(write(bad, "x")).resolves.toBeUndefined();
  });

  it("bootLevel accepts only known levels", () => {
    expect(bootLevel({ FF_LOG_LEVEL: " debug " })).toBe("debug");
    expect(bootLevel({ FF_LOG_LEVEL: "loud" })).toBe("warn");
    expect(bootLevel({})).toBe("warn");
  });

  it("defaultIo reflects the real process; distEntry is absolute under the package root", () => {
    const io = defaultIo();
    expect(io.execPath).toBe(process.execPath);
    expect(io.nodeVersion).toBe(process.versions.node);
    expect(path.isAbsolute(io.packageRoot)).toBe(true);
    expect(distEntry("/p")).toBe("/p/dist/cli.js");
  });

  it("loadRuntime registers config secrets with the logger, so they never reach stderr", async () => {
    const s = sandbox();
    sb = s;
    const planted = "odds-planted-value-777";
    const io = makeIo(s, {
      env: { ODDS_API_KEY: planted, FF_LOG_LEVEL: "debug", FF_BOGUS_KEY: "1" },
    });
    const { log } = await loadRuntime(io);
    log.error("x.y", { note: `leak ${planted}` });
    expect(io.err.text).not.toContain(planted);
    expect(io.err.text).toContain("[redacted:api_key]");
    expect(io.err.text).toContain("config.warning");
  });
});

/** A stdout whose reader went away: every write fails with EPIPE, as a pipe to `head` does. */
class ClosedPipe extends Writable {
  /** An 'error' was emitted with no listener — in a real process, an unhandled crash with a stack. */
  unhandled = 0;
  writes = 0;
  override _write(_c: unknown, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.writes++;
    cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) {
      this.unhandled++;
      return false;
    }
    return super.emit(event, ...args);
  }
}

describe("a closed output pipe (`ff status | head -1`) [QA-1-055]", () => {
  it.each([["help"], ["version"], ["status"], ["doctor"]])(
    "%s ends quietly: no unhandled EPIPE, its own exit code",
    async (cmd) => {
      const s = sandbox();
      sb = s;
      const stdout = new ClosedPipe();
      const io = { ...makeIo(s), stdout };
      const code = await main([cmd], io);
      await new Promise((r) => setImmediate(r));
      expect(stdout.writes).toBeGreaterThan(0);
      expect(stdout.unhandled).toBe(0);
      expect([EXIT.OK, EXIT.ERROR]).toContain(code);
      if (cmd !== "doctor") expect(code).toBe(EXIT.OK);
    },
  );
  it("a closed stderr is tolerated the same way", async () => {
    const s = sandbox();
    sb = s;
    const stderr = new ClosedPipe();
    const io = { ...makeIo(s), stderr };
    expect(await main(["nope"], io)).toBe(EXIT.USAGE);
    await new Promise((r) => setImmediate(r));
    expect(stderr.unhandled).toBe(0);
  });
  it("any other output error is not swallowed", () => {
    const w = new Writable({
      write: (_c, _e, cb) => {
        cb();
      },
    });
    tolerateClosedPipe(w);
    tolerateClosedPipe(w); // idempotent: one listener
    expect(w.listenerCount("error")).toBe(1);
    expect(() => w.emit("error", Object.assign(new Error("disk"), { code: "EIO" }))).toThrow(
      "disk",
    );
    expect(w.emit("error", Object.assign(new Error("gone"), { code: "EPIPE" }))).toBe(true);
  });
});

describe("store-access", () => {
  it("maps FF_WEATHER_SOURCE onto the store's reader preference", () => {
    expect(storeWeatherSource("open-meteo")).toBe("weather:open_meteo");
    expect(storeWeatherSource("nws")).toBe("weather:nws");
    expect(storeWeatherSource("off")).toBeUndefined();
  });

  it("errorText is value-free for path errors and bounded otherwise", () => {
    expect(errorText(new PathSecurityError("symlink", "/planted/path", "x"))).toBe(
      "PathSecurityError: refusing to follow a symbolic link",
    );
    expect(errorText(new Error("y".repeat(1000))).length).toBeLessThan(220);
    expect(errorText("str")).toBe("unknown error");
  });

  it("an existing but unopenable store is an error, never created or thrown", () => {
    const s = sandbox();
    sb = s;
    mkdirSync(s.cacheDir, { mode: 0o755 });
    writeFileSync(path.join(s.cacheDir, "store.sqlite"), "");
    const config = loadConfig({
      env: { FF_CONFIG_DIR: s.configDir, FF_CACHE_DIR: s.cacheDir },
      file: undefined,
      home: s.home,
      repoRoot: ROOT,
    });
    const ex = openExistingStore(config, fixedClock(0), makeLogger(makeIo(s), "error"));
    expect(ex.kind).toBe("error");
  });
});
