// workflows.test.ts — CI hygiene that must hold for every workflow (docs/plan/04 §4: actions pinned
// by commit SHA, contents: read, no pull_request_target, persist-credentials: false) and the
// ci.yml job set of plan 04 §4.1 as built in this stage. Reads the YAML; changes nothing.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  steps?: Step[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
}
interface Workflow {
  on?: unknown;
  permissions?: unknown;
  concurrency?: { "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
}

const dir = path.join(ROOT, ".github", "workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const load = (f: string) => parse(readFileSync(path.join(dir, f), "utf8")) as Workflow;

describe.each(files)("%s", (file) => {
  const wf = load(file);
  const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);

  it("has read-only default permissions", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("never uses pull_request_target", () => {
    expect(JSON.stringify(wf.on ?? {})).not.toContain("pull_request_target");
  });

  it("pins every action to a full commit SHA", () => {
    for (const s of steps) {
      if (s.uses === undefined || s.uses.startsWith("./")) continue;
      expect(s.uses, s.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("checks out without persisting the job token", () => {
    for (const s of steps.filter((x) => x.uses?.startsWith("actions/checkout@"))) {
      expect(s.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("bounds every job with a timeout", () => {
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      expect(job["timeout-minutes"], name).toBeTypeOf("number");
    }
  });
});

/** The one cancel-in-progress expression ci, docs and secrets share. */
const CANCEL_EXPR = "${{ github.event_name == 'pull_request' || github.ref != 'refs/heads/main' }}";

/** Evaluates CANCEL_EXPR-shaped expressions (==, !=, ||, string literals) for a run context. */
function cancels(expr: unknown, ctx: { event_name: string; ref: string }): boolean {
  const m = /^\$\{\{ (.*) \}\}$/.exec(String(expr));
  if (m === null) throw new Error(`not an expression: ${String(expr)}`);
  return (m[1] ?? "").split(" || ").some((term) => {
    const t = /^github\.(event_name|ref) (==|!=) '([^']*)'$/.exec(term.trim());
    if (t === null) throw new Error(`unsupported term: ${term}`);
    const v = ctx[t[1] as "event_name" | "ref"];
    return t[2] === "==" ? v === t[3] : v !== t[3];
  });
}

describe("concurrency: ci, docs and secrets", () => {
  for (const f of ["ci.yml", "docs.yml", "secrets.yml"]) {
    const expr = load(f).concurrency?.["cancel-in-progress"];
    it(`${f}: cancels a superseded PR or non-main push run, never a run on main`, () => {
      expect(expr).toBe(CANCEL_EXPR);
      expect(cancels(expr, { event_name: "pull_request", ref: "refs/pull/7/merge" })).toBe(true);
      expect(cancels(expr, { event_name: "push", ref: "refs/heads/build/phase-1a" })).toBe(true);
      expect(cancels(expr, { event_name: "push", ref: "refs/heads/main" })).toBe(false);
      expect(cancels(expr, { event_name: "schedule", ref: "refs/heads/main" })).toBe(false);
      expect(cancels(expr, { event_name: "workflow_dispatch", ref: "refs/heads/main" })).toBe(
        false,
      );
    });
  }
});

describe("ci.yml", () => {
  const wf = load("ci.yml");
  const jobs = wf.jobs ?? {};
  const runs = (job: string) => (jobs[job]?.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("runs on every push and pull request", () => {
    const on = wf.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(expect.arrayContaining(["push", "pull_request"]));
    expect(on.push).toBeNull(); // no branch/path filter: every push, every branch
  });

  it("cancels superseded runs for pull requests and non-main pushes, never on main", () => {
    // changed deliberately (round-1 gate): a build branch's superseded pushes are CI noise; main's
    // runs stay uncancelled — a cancelled run on main is a commit without a verdict
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(CANCEL_EXPR);
  });

  it("has the plan 04 §4.1 jobs, process and smoke included", () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining([
        "lint",
        "typecheck",
        "test",
        "supply-chain",
        "pack",
        "process",
        "process-macos",
        "smoke",
      ]),
    );
  });

  it("process runs against the built dist; macOS only weekly or on demand (A13)", () => {
    expect(runs("process").indexOf("npm run build")).toBeLessThan(
      runs("process").indexOf("npm run test:process"),
    );
    const env = (jobs.process?.steps ?? []).find((s) => s.run === "npm run test:process") as
      (Step & { env?: Record<string, string> }) | undefined;
    expect(env?.env?.FF_PROCESS_TEST_DIST).toBe("1");
    const mac = jobs["process-macos"] as Job & { if?: string };
    expect(mac["runs-on"]).toMatch(/^macos-/);
    expect(mac.if).toContain("schedule");
    expect(runs("process-macos")).toContain("npm run test:process");
  });

  it("smoke builds, runs the SDK smoke and the Inspector pinned to an exact version (A3a)", () => {
    const smoke = jobs.smoke as Job & { env?: Record<string, string> };
    expect(smoke.env?.INSPECTOR).toMatch(/^@modelcontextprotocol\/inspector@\d+\.\d+\.\d+$/);
    const r = runs("smoke");
    expect(r.indexOf("npm run build")).toBeLessThan(r.indexOf("npm run smoke"));
    expect(r).toContain('npx --yes "$INSPECTOR" --cli');
    expect(r).toContain('--method "$method" --format json');
    expect(r).toContain("tests/smoke/assert-inspector.mjs");
    for (const m of ["tools/list", "resources/list", "resources/templates/list", "prompts/list"])
      expect(r).toContain(m);
    const step = (smoke.steps ?? []).find((s) => s.run?.includes("$INSPECTOR")) as
      (Step & { env?: Record<string, string> }) | undefined;
    expect(step?.env?.npm_config_ignore_scripts).toBe("true");
  });

  it("installs with npm ci and Node from .nvmrc in every job", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const setup = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(setup?.with?.["node-version-file"], name).toBe(".nvmrc");
      expect(runs(name), name).toMatch(/^npm ci$/m);
      expect(runs(name), name).not.toMatch(/npm install/);
    }
  });

  it.each([
    ["lint", ["npm run lint", "npm run format:check"]],
    ["typecheck", ["npm run typecheck"]],
    ["test", ["npm run test:coverage", "npm run check:coverage"]],
    [
      "supply-chain",
      [
        "npm audit --omit=dev --audit-level=high",
        "npm run check:no-scripts",
        "npm run check:licenses",
        "npm run check:runtime-tree",
      ],
    ],
    ["pack", ["npm run build", "npm run pack:scan"]],
    ["process", ["npm run build", "npm run test:process"]],
    ["smoke", ["npm run build", "npm run smoke"]],
  ])("%s runs its gate commands", (job, commands) => {
    for (const c of commands) expect(runs(job)).toContain(c);
  });

  it("the gating audit is not swallowed (only the report-only audit may be)", () => {
    const gate = (jobs["supply-chain"]?.steps ?? []).find((s) =>
      s.run?.includes("--audit-level=high"),
    );
    expect(gate?.run).not.toMatch(/\|\||continue-on-error/);
  });
});

describe("docs.yml", () => {
  const wf = load("docs.yml");
  const jobs = wf.jobs ?? {};
  const runs = (job: string) => (jobs[job]?.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("has the skills job: build-skills --check, then check-skills (plan 09 §5.1; A10)", () => {
    const r = runs("skills");
    expect(r).toContain("node scripts/skills/build-skills.mjs --check");
    expect(r).toContain("node scripts/skills/check-skills.mjs");
    expect(r.indexOf("--check")).toBeLessThan(r.indexOf("check-skills.mjs"));
  });

  it("runs on skills, the checker scripts and the contract files it reads", () => {
    const on = wf.on as Record<string, { paths?: string[] }>;
    for (const trigger of ["push", "pull_request"]) {
      const paths = on[trigger]?.paths ?? [];
      for (const p of [
        "skills/**",
        "scripts/skills/**",
        "src/mcp/registry.ts",
        "src/mcp/errors.ts",
        "src/mcp/envelope.ts",
        "tests/smoke/expected-tools.json",
      ])
        expect(paths, `${trigger} ${p}`).toContain(p);
    }
  });
});
