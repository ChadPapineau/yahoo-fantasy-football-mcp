// main.test.ts — the `ff` dispatcher (plan 03 §1.1 step 1 parseArgs + exit 2 on usage/config;
// §1.3 shared exit codes): every subcommand routes, strict flags, serve is handed stdio untouched.
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import {
  COMMANDS,
  loadServe,
  main,
  parseCommand,
  USAGE,
  type ServeFn,
} from "../../src/cli/main.js";
import { VERSION } from "../../src/version.js";
import { makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

describe("ff dispatcher", () => {
  it("prints the version on stdout (version, --version, -v)", async () => {
    sb = sandbox();
    for (const argv of [["version"], ["--version"], ["-v"]]) {
      const io = makeIo(sb);
      expect(await main(argv, io)).toBe(EXIT.OK);
      expect(io.out.text).toBe(`ff ${VERSION} (node 24.21.0)\n`);
      expect(io.err.text).toBe("");
    }
  });

  it("help goes to stdout with exit 0; no command is a usage error on stderr", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["help"], io)).toBe(EXIT.OK);
    expect(io.out.text).toContain("usage: ff <command>");
    const io2 = makeIo(sb);
    expect(await main(["-h"], io2)).toBe(EXIT.OK);
    const io3 = makeIo(sb);
    expect(await main([], io3)).toBe(EXIT.USAGE);
    expect(io3.out.text).toBe("");
    expect(io3.err.text).toContain(USAGE.split("\n")[0]);
  });

  it("unknown commands, unknown flags, missing values and extra positionals exit 2", async () => {
    sb = sandbox();
    for (const argv of [
      ["frobnicate"],
      ["status", "--nope"],
      ["print-config", "--client"],
      ["status", "extra"],
      ["refresh", "all", "more"],
      ["version", "--json"],
      ["__proto__"],
      ["constructor"],
    ]) {
      const io = makeIo(sb);
      expect(await main(argv, io), argv.join(" ")).toBe(EXIT.USAGE);
      expect(io.err.text).toMatch(/^ff: /);
      expect(io.out.text).toBe("");
    }
  });

  it("a configuration error (invalid FF_LOG_LEVEL) exits 2 naming the key, never the value", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { FF_LOG_LEVEL: "shout-SECRETVALUE" } });
    expect(await main(["status"], io)).toBe(EXIT.USAGE);
    expect(io.err.text).toContain("FF_LOG_LEVEL");
    expect(io.err.text).not.toContain("SECRETVALUE");
  });

  it("a relative FF_CACHE_DIR is a configuration error (plan 03 §1.1)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { FF_CACHE_DIR: "relative/cache" } });
    expect(await main(["status"], io)).toBe(EXIT.USAGE);
    expect(io.err.text).toContain("FF_CACHE_DIR");
  });

  it("serve receives the remaining argv and the raw stdio, and its code is the exit code", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    let seen: Parameters<ServeFn>[0] | null = null;
    const serve: ServeFn = (opts) => {
      seen = opts;
      return Promise.resolve(5);
    };
    expect(await main(["serve", "--x", "y"], io, { loadServe: () => Promise.resolve(serve) })).toBe(
      5,
    );
    expect(seen).not.toBeNull();
    const s = seen as unknown as Parameters<ServeFn>[0];
    expect(s.argv).toEqual(["--x", "y"]);
    expect(s.stdout).toBe(io.stdout);
    expect(s.stdin).toBe(io.stdin);
    expect(s.clock).toBe(io.clock);
    expect(io.out.text).toBe("");
  });

  it("loadServe refuses a module without a serve export", async () => {
    await expect(loadServe("node:path")).rejects.toThrow(/does not export serve/);
  });

  it("an unexpected error is exit 1 with a one-line message and no stack on stdout", async () => {
    sb = sandbox();
    // FF_CACHE_DIR is a regular file: the store cannot be created under it.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sb.cacheDir, "not a dir");
    const io = makeIo(sb);
    const code = await main(["backup"], io);
    expect(code).toBe(EXIT.ERROR);
    expect(io.out.text).toBe("");
    expect(io.err.text).toMatch(/ff backup: /);
  });

  it("parseCommand keeps only string/boolean values and rejects unknown commands", () => {
    expect(parseCommand("refresh", ["all", "--force"]).values.force).toBe(true);
    expect(parseCommand("refresh", ["all"]).positionals).toEqual(["all"]);
    expect(() => parseCommand("toString", [])).toThrow(/unknown command/);
    expect(() => parseCommand("x".repeat(500), [])).toThrow(/unknown command 'x{40}'$/);
  });

  it("every command in the list dispatches without an 'unknown command' error", async () => {
    sb = sandbox();
    for (const c of COMMANDS) {
      if (c === "serve") continue;
      const io = makeIo(sb);
      await main([c, "--definitely-not-a-flag"], io);
      expect(io.err.text, c).not.toContain("unknown command");
    }
  });
});

describe("hostile arguments", () => {
  it("doctor path flags must be absolute; ~/ expands against HOME", async () => {
    sb = sandbox();
    for (const v of ["relative.json", "", "~other/x", "a\0b"]) {
      const io = makeIo(sb);
      expect(await main(["doctor", "--client-config", v], io), JSON.stringify(v)).toBe(EXIT.USAGE);
      expect(io.out.text).toBe("");
    }
    const io = makeIo(sb);
    expect(await main(["doctor", "--json", "--client-log", "~/none.log"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toContain(`${sb.home}/none.log`);
  });

  it("a megabyte-long argument is refused quickly without echoing it", async () => {
    sb = sandbox();
    const huge = "9".repeat(1024 * 1024);
    const t0 = Date.now();
    for (const argv of [
      ["refresh", "all", "--seasons", huge],
      ["refresh", huge],
      ["install-launchd", "--jobs", huge],
    ]) {
      const io = makeIo(sb);
      expect(await main(argv, io)).toBe(EXIT.USAGE);
      expect(io.err.text.length).toBeLessThan(2000);
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("unicode and control characters in a target are refused, never echoed raw", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    expect(await main(["refresh", "nflverse:‮schedules\u0007"], io)).toBe(EXIT.USAGE);
    expect(io.err.text).not.toContain("‮");
  });
});
