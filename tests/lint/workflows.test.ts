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

describe("ci.yml", () => {
  const wf = load("ci.yml");
  const jobs = wf.jobs ?? {};
  const runs = (job: string) => (jobs[job]?.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("runs on every push and pull request", () => {
    const on = wf.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(expect.arrayContaining(["push", "pull_request"]));
    expect(on.push).toBeNull(); // no branch/path filter: every push, every branch
  });

  it("cancels superseded runs for pull requests only", () => {
    expect(String(wf.concurrency?.["cancel-in-progress"])).toContain(
      "github.event_name == 'pull_request'",
    );
  });

  it("has the plan 04 §4.1 jobs (process/smoke join in a later stage)", () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(["lint", "typecheck", "test", "supply-chain", "pack"]),
    );
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
