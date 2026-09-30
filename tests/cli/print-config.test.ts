// print-config.test.ts — plan 05 §2 `cli/print-config`: output paths are absolute and exist; no
// secret value present; `command` equals process.execPath; plan 03 §4.2 the `claude mcp add` line.
import fc from "fast-check";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { main } from "../../src/cli/main.js";
import {
  codeCommand,
  desktopSnippet,
  launchEnv,
  SERVER_NAME,
  shellQuote,
} from "../../src/cli/print-config.js";
import { loadConfig } from "../../src/config/schema.js";
import { fakePackage, makeIo, ROOT, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const SECRET = "fake-odds-value-0123456789";
const CLIENT_SECRET = "fake-client-secret-value-9f8e7d";

/** Undoes shellQuote for a line of words (single-quote POSIX rules only). */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === "\\") {
      cur += line.charAt(i + 1);
      i++;
      inWord = true;
    } else if (ch === " ") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

describe("ff print-config --client desktop", () => {
  it("prints absolute, existing paths; command = execPath; args end in serve; no secrets", async () => {
    sb = sandbox();
    const pkg = fakePackage(sb);
    const io = makeIo(sb, {
      packageRoot: pkg,
      env: { YAHOO_CLIENT_SECRET: CLIENT_SECRET, ODDS_API_KEY: SECRET, FF_WEATHER_SOURCE: "nws" },
    });
    expect(await main(["print-config", "--client", "desktop"], io)).toBe(EXIT.OK);
    const parsed = JSON.parse(io.out.text) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = parsed.mcpServers[SERVER_NAME];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.command).toBe(process.execPath);
    expect(path.isAbsolute(entry.command) && existsSync(entry.command)).toBe(true);
    expect(entry.args[0]).toBe(path.join(pkg, "dist", "cli.js"));
    expect(path.isAbsolute(entry.args[0] ?? "") && existsSync(entry.args[0] ?? "")).toBe(true);
    expect(entry.args.at(-1)).toBe("serve");
    expect(entry.env.FF_CONFIG_DIR).toBe(sb.configDir);
    expect(entry.env.FF_CACHE_DIR).toBe(sb.cacheDir);
    expect(entry.env.FF_WEATHER_SOURCE).toBe("nws");
    expect(entry.env.FF_LOG_LEVEL).toBe("info");
    const all = io.out.text + io.err.text;
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(CLIENT_SECRET);
    expect(all).not.toMatch(/YAHOO_CLIENT_SECRET|ODDS_API_KEY/);
    expect(io.err.text).toContain("claude_desktop_config.json");
  });

  it("an unbuilt checkout exits 1 with nothing on stdout (never a config naming a missing file)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: fakePackage(sb, { built: false }) });
    expect(await main(["print-config", "--client", "desktop"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toBe("");
    expect(io.err.text).toContain("npm run build");
  });

  it("a missing or unknown --client is a usage error", async () => {
    sb = sandbox();
    for (const argv of [
      ["print-config"],
      ["print-config", "--client", "cursor"],
      ["print-config", "--client", "__proto__"],
    ]) {
      const io = makeIo(sb, { packageRoot: fakePackage(sb) });
      expect(await main(argv, io)).toBe(EXIT.USAGE);
      expect(io.out.text).toBe("");
    }
  });

  it("a relative execPath is refused (GUI clients have no shell PATH)", async () => {
    sb = sandbox();
    const io = makeIo(sb, { packageRoot: fakePackage(sb), execPath: "node" });
    expect(await main(["print-config", "--client", "desktop"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toBe("");
  });
});

describe("ff print-config --client code", () => {
  it("prints a user-scope claude mcp add line whose words round-trip through a shell", async () => {
    sb = sandbox();
    const pkg = fakePackage(sb);
    const io = makeIo(sb, { packageRoot: pkg, env: { ODDS_API_KEY: SECRET } });
    expect(await main(["print-config", "--client", "code"], io)).toBe(EXIT.OK);
    const words = shellSplit(io.out.text.trim());
    expect(words.slice(0, 8)).toEqual([
      "claude",
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      SERVER_NAME,
    ]);
    const dash = words.indexOf("--");
    expect(words.slice(dash + 1)).toEqual([
      process.execPath,
      path.join(pkg, "dist", "cli.js"),
      "serve",
    ]);
    expect(words).toContain(`FF_CONFIG_DIR=${sb.configDir}`);
    expect(io.out.text).not.toContain(SECRET);
  });

  it("quotes paths with spaces, quotes and shell metacharacters", () => {
    const spec = {
      command: "/Users/a b/node's",
      args: ["/x/$(rm -rf ~)/cli.js", "serve"],
      env: { FF_CACHE_DIR: "/tmp/a;b" },
    };
    const words = shellSplit(codeCommand(spec));
    expect(words).toContain("/Users/a b/node's");
    expect(words).toContain("/x/$(rm -rf ~)/cli.js");
    expect(words).toContain("FF_CACHE_DIR=/tmp/a;b");
    expect(desktopSnippet(spec)).toContain('"/x/$(rm -rf ~)/cli.js"');
  });

  it("property: shellQuote round-trips any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(shellSplit(`x ${shellQuote(s)} y`)).toEqual(["x", s, "y"]);
      }),
      { numRuns: 500 },
    );
  });
});

describe("launchEnv", () => {
  it("copies only env-origin non-secret keys, resolved; FF_LOG_LEVEL always", () => {
    sb = sandbox();
    const config = loadConfig({
      env: {
        FF_CACHE_DIR: sb.cacheDir,
        FF_TOOLSET: "full",
        FF_WRITE_ENABLED: "1",
        YAHOO_CLIENT_ID: "abc",
        FF_LEAGUE_KEYS: "manual.l.example, 461.l.1000",
      },
      file: { FF_LOG_LEVEL: "debug" },
      home: sb.home,
      repoRoot: ROOT,
    });
    const env = launchEnv(config);
    expect(env).toEqual({
      FF_CACHE_DIR: sb.cacheDir,
      FF_TOOLSET: "full",
      FF_LEAGUE_KEYS: "manual.l.example,461.l.1000",
      FF_LOG_LEVEL: "debug",
    });
  });
});
