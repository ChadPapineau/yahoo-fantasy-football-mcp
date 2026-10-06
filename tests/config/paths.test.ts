// paths.test.ts — src/config/paths.ts (plan 02 §3.3: never relative, never inside the repo, 0700
// dirs / 0600 files, refuse group/other bits, never follow a symlink; plan 01 §5.1 XDG; plan 01 §5.5
// dataset file naming). Adversarial: relative paths, `~user`, NUL bytes, `..`, symlinks into the
// repo and into synced folders, group-writable dirs, wrong owner, oversize files, pre-placed links.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DIR_NAME,
  PathSecurityError,
  SOURCE_ID_RE,
  assertNotSynced,
  assertOutsideRepo,
  assertSecureFile,
  backupDir,
  configFilePath,
  datasetDir,
  datasetFilePath,
  datasetFileStem,
  datasetSchemaName,
  datasetTempPath,
  defaultLeagueFilePath,
  ensureSecureDir,
  expandHome,
  insecureAncestors,
  isInside,
  packageRoot,
  readSecureFile,
  realpathOfExistingPrefix,
  resolveAbsolute,
  resolveCacheDir,
  resolveConfigDir,
  storePath,
  syncedFolders,
  writeSecureFileAtomic,
  type PathRefusal,
} from "../../src/config/paths.js";
import { ROOT, tempDir } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
  tmp.cleanup();
});

function refusal(fn: () => unknown): PathRefusal | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    if (e instanceof PathSecurityError) return e.reason;
    throw e;
  }
}

const mode = (p: string) => lstatSync(p).mode & 0o777;

describe("expandHome / resolveAbsolute", () => {
  const home = "/home/example";
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/x/y", home)).toBe("/home/example/x/y");
    expect(expandHome("/abs", home)).toBe("/abs");
    expect(expandHome("rel", home)).toBe("rel");
  });
  it("refuses the ~user form", () => {
    expect(refusal(() => expandHome("~root/.ssh", home))).toBe("home_user_form");
  });
  it("normalises . and .. and trailing slashes", () => {
    expect(resolveAbsolute("/a/b/../c/./d/", home)).toBe("/a/c/d");
    expect(resolveAbsolute("~/../other", home)).toBe("/home/other");
  });
  it.each([
    ["relative", "relative/path"],
    ["relative", "./here"],
    ["relative", "../up"],
    ["empty", ""],
    ["nul_byte", "/tmp/a\0b"],
    ["home_user_form", "~bob"],
  ] as const)("refuses %s (%j)", (reason, p) => {
    expect(refusal(() => resolveAbsolute(p, home))).toBe(reason);
  });
  it("the error message shows the NUL escaped, and `detail` never shows the path", () => {
    try {
      resolveAbsolute("/tmp/a\0b", home, "FF_CACHE_DIR");
    } catch (e) {
      expect(e).toBeInstanceOf(PathSecurityError);
      const err = e as PathSecurityError;
      expect(err.message).not.toContain("\0");
      expect(err.message).toContain("FF_CACHE_DIR");
      expect(err.detail).not.toContain("/tmp");
      expect(err.ffCode).toBe("INTERNAL");
    }
  });
});

describe("resolveConfigDir / resolveCacheDir (XDG)", () => {
  const home = "/home/example";
  it("defaults to ~/.config and ~/.cache", () => {
    expect(resolveConfigDir({}, home)).toBe(`/home/example/.config/${APP_DIR_NAME}`);
    expect(resolveCacheDir({}, home)).toBe(`/home/example/.cache/${APP_DIR_NAME}`);
  });
  it("honours absolute XDG_*_HOME", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/conf", XDG_CACHE_HOME: "/xdg/cache/" };
    expect(resolveConfigDir(env, home)).toBe(`/xdg/conf/${APP_DIR_NAME}`);
    expect(resolveCacheDir(env, home)).toBe(`/xdg/cache/${APP_DIR_NAME}`);
  });
  it("ignores a relative or NUL-bearing XDG value (the XDG spec says it is invalid)", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "rel/conf" }, home)).toBe(
      `/home/example/.config/${APP_DIR_NAME}`,
    );
    expect(resolveCacheDir({ XDG_CACHE_HOME: "/x\0y" }, home)).toBe(
      `/home/example/.cache/${APP_DIR_NAME}`,
    );
  });
  it("FF_* overrides win over XDG; whitespace-only is unset; ~ expands", () => {
    const env = { FF_CONFIG_DIR: " ~/ffconf ", XDG_CONFIG_HOME: "/xdg", FF_CACHE_DIR: "   " };
    expect(resolveConfigDir(env, home)).toBe("/home/example/ffconf");
    expect(resolveCacheDir(env, home)).toBe(`/home/example/.cache/${APP_DIR_NAME}`);
    expect(resolveCacheDir({}, home, "/explicit")).toBe("/explicit");
  });
  it("a relative FF_CONFIG_DIR is refused, not resolved against cwd", () => {
    expect(refusal(() => resolveConfigDir({ FF_CONFIG_DIR: "conf" }, home))).toBe("relative");
    expect(refusal(() => resolveCacheDir({ FF_CACHE_DIR: "cache" }, home))).toBe("relative");
  });
});

describe("isInside / assertOutsideRepo", () => {
  it("is exact about path segments", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
    expect(isInside("/a/b/../c", "/a/b")).toBe(false);
  });

  it("packageRoot() is this checkout", () => {
    expect(packageRoot()).toBe(ROOT);
  });

  it("refuses the repo itself, anything under it, and a symlink that resolves into it", () => {
    const repo = path.join(tmp.dir, "repo");
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    const link = path.join(tmp.dir, "sneaky");
    symlinkSync(path.join(repo, "sub"), link);
    expect(
      refusal(() => {
        assertOutsideRepo(repo, repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(repo, "sub", "x.yaml"), repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(link, "not-yet-created", "league.yaml"), repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(tmp.dir, "repo-sibling"), repo);
      }),
    ).toBe("no-throw");
    expect(
      refusal(() => {
        assertOutsideRepo(tmp.dir, repo);
      }),
    ).toBe("no-throw");
  });

  it("realpathOfExistingPrefix keeps the missing tail and survives a fully missing path", () => {
    expect(realpathOfExistingPrefix(path.join(tmp.dir, "a", "b"))).toBe(
      path.join(tmp.dir, "a", "b"),
    );
    expect(realpathOfExistingPrefix("/definitely/not/here")).toBe("/definitely/not/here");
  });

  it("refuses this real checkout for a config dir", () => {
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(ROOT, "fixtures", "league.yaml"), packageRoot());
      }),
    ).toBe("inside_repo");
  });
});

describe("assertNotSynced (iCloud Desktop & Documents, iCloud Drive, CloudStorage)", () => {
  it("lists the synced roots: iCloud, CloudStorage, and the Dropbox / Google Drive / OneDrive folders", () => {
    expect(syncedFolders("/Users/x")).toEqual([
      "/Users/x/Documents",
      "/Users/x/Desktop",
      "/Users/x/Library/Mobile Documents",
      "/Users/x/Library/CloudStorage",
      "/Users/x/Dropbox",
      "/Users/x/Google Drive",
      "/Users/x/OneDrive",
    ]);
  });
  it("adds every ~/OneDrive* folder (a business OneDrive is 'OneDrive - <org>') [QA-1-044]", () => {
    mkdirSync(path.join(tmp.dir, "OneDrive - Example Org"));
    mkdirSync(path.join(tmp.dir, "OneDriveLookalike"));
    mkdirSync(path.join(tmp.dir, "MyOneDrive"));
    const roots = syncedFolders(tmp.dir);
    expect(roots).toContain(path.join(tmp.dir, "OneDrive - Example Org"));
    expect(roots).not.toContain(path.join(tmp.dir, "MyOneDrive"));
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, "OneDrive - Example Org", "ff"), tmp.dir);
      }),
    ).toBe("synced_folder");
  });
  it("a refusal names the folder it refused, for every folder the guard refuses [QA-2-001]", () => {
    // the guard's own list, including a dynamic entry, so a folder added to the guard without
    // a name in the message fails here; a name is `~/<folder>` or a `~/<prefix>*` wildcard
    mkdirSync(path.join(tmp.dir, "OneDrive - Example Org"));
    const roots = syncedFolders(tmp.dir);
    expect(roots).toContain(path.join(tmp.dir, "OneDrive - Example Org"));
    const unnamed: string[] = [];
    for (const root of roots) {
      let detail = "";
      try {
        assertNotSynced(path.join(root, "ff"), tmp.dir);
      } catch (e) {
        if (!(e instanceof PathSecurityError) || e.reason !== "synced_folder") throw e;
        detail = e.detail;
      }
      expect(detail, `${root} is refused`).not.toBe("");
      const rel = path.relative(tmp.dir, root);
      const wildcards = [...detail.matchAll(/~\/([^,;()*]+)\*/g)].map((m) => m[1] ?? "");
      const named =
        detail.includes(`~/${rel}`) || wildcards.some((w) => w !== "" && rel.startsWith(w));
      if (!named) unnamed.push(rel);
    }
    expect(unnamed).toEqual([]);
  });
  it.each([
    "Documents/ff",
    "Desktop",
    "Library/Mobile Documents/com~apple~CloudDocs/ff",
    "Library/CloudStorage/GoogleDrive/ff",
    "Dropbox/ff",
    "Google Drive/ff",
    "OneDrive/ff",
  ])("refuses %s", (rel) => {
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
      }),
    ).toBe("synced_folder");
  });
  it("refuses a path that reaches Documents through a symlink", () => {
    mkdirSync(path.join(tmp.dir, "Documents"));
    symlinkSync(path.join(tmp.dir, "Documents"), path.join(tmp.dir, "docs-link"));
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, "docs-link", "ff"), tmp.dir);
      }),
    ).toBe("synced_folder");
  });
  it("allows ~/.config, ~/.cache and a lookalike name", () => {
    for (const rel of [".config/ff", ".cache/ff", "DocumentsArchive/ff"]) {
      expect(
        refusal(() => {
          assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
        }),
      ).toBe("no-throw");
    }
  });
});

describe("location guards see every spelling of a path (QA-1-086)", () => {
  const onDarwin = process.platform === "darwin";
  it.runIf(onDarwin)(
    "refuses a differently-cased spelling of an existing synced folder (case-insensitive APFS)",
    () => {
      mkdirSync(path.join(tmp.dir, "Documents"));
      mkdirSync(path.join(tmp.dir, "Library", "Mobile Documents"), { recursive: true });
      for (const rel of [
        "documents/ff-cache",
        "DOCUMENTS/ff-cache",
        "dOcUmEnTs",
        "library/mobile documents/x",
        "LIBRARY/MOBILE DOCUMENTS",
      ]) {
        expect(
          refusal(() => {
            assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
          }),
          rel,
        ).toBe("synced_folder");
      }
    },
  );
  it.runIf(onDarwin)("refuses a differently-cased synced folder that does not exist yet", () => {
    for (const rel of ["documents/ff", "DESKTOP", "Library/cloudstorage/Drive/ff"]) {
      expect(
        refusal(() => {
          assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
        }),
        rel,
      ).toBe("synced_folder");
    }
  });
  it.runIf(onDarwin)("refuses a Unicode-normalisation variant of a synced folder", () => {
    // APFS is normalisation-insensitive: NFD and NFC spellings name the same directory.
    const home = path.join(tmp.dir, "Jose\u0301");
    mkdirSync(path.join(home, "Documents"), { recursive: true });
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, "Jos\u00e9", "Documents", "ff"), home);
      }),
    ).toBe("synced_folder");
  });
  it.runIf(onDarwin)("refuses a differently-cased spelling of the repository checkout", () => {
    for (const p of [
      path.join(ROOT.toUpperCase(), "probe"),
      path.join(ROOT.toLowerCase(), "fixtures", "x"),
      ROOT.toUpperCase(),
    ]) {
      expect(
        refusal(() => {
          assertOutsideRepo(p, ROOT);
        }),
        p,
      ).toBe("inside_repo");
    }
  });
  it("still allows lookalike names and sibling directories", () => {
    for (const rel of ["DocumentsArchive/ff", "documents-old", ".config/ff"]) {
      expect(
        refusal(() => {
          assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
        }),
        rel,
      ).toBe("no-throw");
    }
    expect(
      refusal(() => {
        assertOutsideRepo(`${ROOT}-sibling/x`, ROOT);
      }),
    ).toBe("no-throw");
  });
});

describe("derived locations and dataset naming (plan 01 §5.5)", () => {
  const cache = "/c";
  it("builds the fixed layout", () => {
    expect(storePath(cache)).toBe("/c/store.sqlite");
    expect(datasetDir(cache)).toBe("/c/ds");
    expect(backupDir(cache)).toBe("/c/backups");
    expect(configFilePath("/k")).toBe("/k/config.json");
    expect(defaultLeagueFilePath("/k")).toBe("/k/league.yaml");
  });
  it("maps a source id to a stable file, schema and temp name", () => {
    expect(datasetFileStem("nflverse:stats_player_week")).toBe("nflverse__stats_player_week");
    expect(datasetFilePath(cache, "nflverse:injuries")).toBe("/c/ds/nflverse__injuries.sqlite");
    expect(datasetSchemaName("weather:open_meteo")).toBe("ds_weather__open_meteo");
    const t1 = datasetTempPath(cache, "nflverse:injuries", "2026-09-30T14:03:00Z");
    const t2 = datasetTempPath(cache, "nflverse:injuries", "2026-09-30T14:03:00Z");
    expect(t1).toMatch(/^\/c\/ds\/nflverse__injuries\.2026-09-30T14_03_00Z\.[0-9a-f]{12}\.tmp$/);
    expect(t1).not.toBe(t2);
    expect(path.dirname(datasetTempPath(cache, "nflverse:injuries", "../../../etc/passwd"))).toBe(
      "/c/ds",
    );
    expect(datasetTempPath(cache, "nflverse:injuries", "")).toMatch(/\.v\.[0-9a-f]{12}\.tmp$/);
  });
  it.each([
    "",
    "nflverse",
    "NFLverse:x",
    "nflverse:",
    ":x",
    "a:b:c",
    "../x:y",
    "nflverse:stats player",
    "nfl\u0000:x",
  ])("rejects source id %j", (bad) => {
    expect(SOURCE_ID_RE.test(bad)).toBe(false);
    expect(() => datasetFileStem(bad)).toThrow(RangeError);
  });
});

describe("ensureSecureDir (0700, no symlink, owner only)", () => {
  it("creates a missing dir (and parents) 0700", () => {
    const d = path.join(tmp.dir, "a", "b", "conf");
    ensureSecureDir(d, { create: true });
    expect(statSync(d).isDirectory()).toBe(true);
    expect(mode(d)).toBe(0o700);
    expect(mode(path.join(tmp.dir, "a"))).toBe(0o700);
  });
  it("accepts an existing 0700 dir; refuses a missing dir without create", () => {
    const d = path.join(tmp.dir, "ok");
    mkdirSync(d, { mode: 0o700 });
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "nope"), { create: false });
      }),
    ).toBe("missing");
  });
  it.each([0o750, 0o705, 0o770, 0o777, 0o701])(
    "refuses an existing dir with mode %o and does not chmod it",
    (m) => {
      const d = path.join(tmp.dir, "loose");
      mkdirSync(d);
      chmodSync(d, m);
      expect(
        refusal(() => {
          ensureSecureDir(d, { create: true });
        }),
      ).toBe("insecure_mode");
      expect(mode(d)).toBe(m);
    },
  );
  it("refuses a symlink to a good dir (never followed) and a regular file", () => {
    const real = path.join(tmp.dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(tmp.dir, "link"));
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "link"), { create: true });
      }),
    ).toBe("symlink");
    writeFileSync(path.join(tmp.dir, "file"), "x");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "file"), { create: true });
      }),
    ).toBe("not_directory");
  });
  it("refuses a dir owned by another uid", () => {
    const d = path.join(tmp.dir, "theirs");
    mkdirSync(d, { mode: 0o700 });
    vi.spyOn(process, "getuid").mockReturnValue(424242);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("wrong_owner");
  });
  it("skips the owner check where getuid does not exist (non-POSIX)", () => {
    const d = path.join(tmp.dir, "any");
    mkdirSync(d, { mode: 0o700 });
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(
        refusal(() => {
          ensureSecureDir(d, { create: false });
        }),
      ).toBe("no-throw");
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });
  it("propagates an unexpected lstat error (e.g. a path through a file)", () => {
    const f = path.join(tmp.dir, "plain");
    writeFileSync(f, "x");
    expect(() => {
      ensureSecureDir(path.join(f, "child"), { create: false });
    }).toThrow(/ENOTDIR/);
  });
});

describe("assertSecureFile (0600, regular, no symlink)", () => {
  it("accepts 0600 and 0400; refuses group/other bits", () => {
    const f = path.join(tmp.dir, "league.yaml");
    writeFileSync(f, "x", { mode: 0o600 });
    expect(
      refusal(() => {
        assertSecureFile(f);
      }),
    ).toBe("no-throw");
    chmodSync(f, 0o400);
    expect(
      refusal(() => {
        assertSecureFile(f);
      }),
    ).toBe("no-throw");
    for (const m of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(f, m);
      expect(
        refusal(() => {
          assertSecureFile(f);
        }),
      ).toBe("insecure_mode");
    }
  });
  it("refuses a symlink, a directory and a missing file", () => {
    const f = path.join(tmp.dir, "t");
    writeFileSync(f, "x", { mode: 0o600 });
    symlinkSync(f, path.join(tmp.dir, "l"));
    expect(
      refusal(() => {
        assertSecureFile(path.join(tmp.dir, "l"));
      }),
    ).toBe("symlink");
    expect(
      refusal(() => {
        assertSecureFile(tmp.dir);
      }),
    ).toBe("not_regular_file");
    expect(
      refusal(() => {
        assertSecureFile(path.join(tmp.dir, "none"));
      }),
    ).toBe("missing");
  });
});

describe("readSecureFile (O_NOFOLLOW, checks on the open descriptor)", () => {
  it("returns null for a missing file and the text for a private one", () => {
    expect(readSecureFile(path.join(tmp.dir, "none"), { requirePrivate: true })).toBeNull();
    const f = path.join(tmp.dir, "league.yaml");
    writeFileSync(f, "league: Example League\n", { mode: 0o600 });
    expect(readSecureFile(f, { requirePrivate: true })).toBe("league: Example League\n");
  });
  it("enforces 0600 only when asked (config.json holds no secrets)", () => {
    const f = path.join(tmp.dir, "config.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(readSecureFile(f, { requirePrivate: false })).toBe("{}");
    expect(refusal(() => readSecureFile(f, { requirePrivate: true }))).toBe("insecure_mode");
  });
  it("refuses a symlink even to a good file, and a directory", () => {
    const f = path.join(tmp.dir, "real.yaml");
    writeFileSync(f, "x", { mode: 0o600 });
    symlinkSync(f, path.join(tmp.dir, "link.yaml"));
    expect(
      refusal(() => readSecureFile(path.join(tmp.dir, "link.yaml"), { requirePrivate: false })),
    ).toBe("symlink");
    expect(refusal(() => readSecureFile(tmp.dir, { requirePrivate: false }))).toBe(
      "not_regular_file",
    );
  });
  it("refuses an oversize file", () => {
    const f = path.join(tmp.dir, "big");
    writeFileSync(f, "x".repeat(2048), { mode: 0o600 });
    expect(refusal(() => readSecureFile(f, { requirePrivate: true, maxBytes: 1024 }))).toBe(
      "too_large",
    );
    expect(readSecureFile(f, { requirePrivate: true, maxBytes: 2048 })).toHaveLength(2048);
  });
  it("propagates other open errors (e.g. a path through a file)", () => {
    const f = path.join(tmp.dir, "plain");
    writeFileSync(f, "x");
    expect(() => readSecureFile(path.join(f, "child"), { requirePrivate: false })).toThrow(
      /ENOTDIR/,
    );
  });
  it("reads multi-byte UTF-8 intact", () => {
    const f = path.join(tmp.dir, "u.yaml");
    writeFileSync(f, "team: Équipe 😀\n", { mode: 0o600 });
    expect(readSecureFile(f, { requirePrivate: true })).toBe("team: Équipe 😀\n");
  });
});

describe("writeSecureFileAtomic (wx temp + fsync + rename, 0600)", () => {
  const dirOf = () => {
    const d = path.join(tmp.dir, "conf");
    mkdirSync(d, { mode: 0o700 });
    return d;
  };
  it("writes a 0600 file and replaces an existing one, leaving no temp files", () => {
    const d = dirOf();
    const f = path.join(d, "state.json");
    writeSecureFileAtomic(f, "one");
    expect(readFileSync(f, "utf8")).toBe("one");
    expect(mode(f)).toBe(0o600);
    writeSecureFileAtomic(f, new TextEncoder().encode("two"));
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(d)).toEqual(["state.json"]);
  });
  it("refuses to write through a pre-placed symlink at the target", () => {
    const d = dirOf();
    const victim = path.join(tmp.dir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(d, "state.json"));
    expect(
      refusal(() => {
        writeSecureFileAtomic(path.join(d, "state.json"), "evil");
      }),
    ).toBe("symlink");
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });
  it("refuses an insecure parent directory", () => {
    const d = path.join(tmp.dir, "open");
    mkdirSync(d);
    chmodSync(d, 0o755);
    expect(
      refusal(() => {
        writeSecureFileAtomic(path.join(d, "x"), "y");
      }),
    ).toBe("insecure_mode");
    expect(existsSync(path.join(d, "x"))).toBe(false);
  });
  it("on a failed rename, removes the temp file and leaves the target untouched", () => {
    const d = dirOf();
    const target = path.join(d, "is-a-dir");
    mkdirSync(target);
    writeFileSync(path.join(target, "inner"), "x");
    expect(() => {
      writeSecureFileAtomic(target, "data");
    }).toThrow();
    expect(readdirSync(d)).toEqual(["is-a-dir"]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});

describe("hardening (critic C-20): FIFOs never block; insecure ancestors are refused", () => {
  it("a FIFO planted at league.yaml is refused as not_regular_file without blocking", () => {
    const f = path.join(tmp.dir, "league.yaml");
    execFileSync("mkfifo", [f]);
    const started = Date.now();
    expect(refusal(() => readSecureFile(f, { requirePrivate: true }))).toBe("not_regular_file");
    expect(refusal(() => readSecureFile(f, { requirePrivate: false }))).toBe("not_regular_file");
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("refuses a dir under a world-writable, non-sticky ancestor (it could be swapped)", () => {
    const shared = path.join(tmp.dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const d = path.join(shared, "conf");
    mkdirSync(d, { mode: 0o700 });
    expect(insecureAncestors(d)).toEqual([shared]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("insecure_ancestor");
    // creating beneath it is refused too (after the create, before any use)
    expect(
      refusal(() => {
        ensureSecureDir(path.join(shared, "new", "conf"), { create: true });
      }),
    ).toBe("insecure_ancestor");
  });
  it("follows a symlinked component to its real ancestors (QA-1-091)", () => {
    const shared = path.join(tmp.dir, "shared");
    mkdirSync(path.join(shared, "mine"), { recursive: true });
    chmodSync(shared, 0o777);
    chmodSync(path.join(shared, "mine"), 0o700);
    symlinkSync(path.join(shared, "mine"), path.join(tmp.dir, "link"));
    const viaLink = path.join(tmp.dir, "link", "cache");
    mkdirSync(viaLink, { mode: 0o700 });
    expect(insecureAncestors(viaLink)).toContain(shared);
    expect(
      refusal(() => {
        ensureSecureDir(viaLink, { create: false });
      }),
    ).toBe("insecure_ancestor");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "link", "cache2"), { create: true });
      }),
    ).toBe("insecure_ancestor");
  });
  it("creates nothing beneath an insecure ancestor (the refusal comes before mkdir) (QA-1-091)", () => {
    const shared = path.join(tmp.dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    expect(
      refusal(() => {
        ensureSecureDir(path.join(shared, "a", "b"), { create: true });
      }),
    ).toBe("insecure_ancestor");
    expect(readdirSync(shared)).toEqual([]);
  });
  it("a group-writable ancestor is refused; the sticky bit (like /tmp) makes it safe", () => {
    const g = path.join(tmp.dir, "grp");
    mkdirSync(g);
    chmodSync(g, 0o770);
    const d = path.join(g, "conf");
    mkdirSync(d, { mode: 0o700 });
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("insecure_ancestor");
    chmodSync(g, 0o1777);
    expect(insecureAncestors(d)).toEqual([]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
  });
  it("a 0755 chain is fine and the dir itself is not counted as its own ancestor", () => {
    const d = path.join(tmp.dir, "ok");
    mkdirSync(d, { mode: 0o700 });
    expect(insecureAncestors(d)).toEqual([]);
    expect(insecureAncestors("/")).toEqual([]);
  });
  it("PathSecurityError is INTERNAL, never VALIDATION (a 0644 league.yaml is not the model's fault)", () => {
    const f = path.join(tmp.dir, "league.yaml");
    writeFileSync(f, "x: 1\n");
    chmodSync(f, 0o644);
    try {
      readSecureFile(f, { requirePrivate: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PathSecurityError);
      expect((e as PathSecurityError).ffCode).toBe("INTERNAL");
    }
  });
});
