// world.ts — a fixture-mode server for the Skills' claim tests (plan 09 §2 guardrail 7, §5.1): the
// Skills tell the model what the tools return, so every such claim is checked here against the real
// server (tests/mcp/helpers/env.ts: the real modules over the fixture datasets and the fixture
// manual league), never against a paraphrase of it.
import { chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "../mcp/helpers/env.js";

export { T0 } from "../mcp/helpers/env.js";

/** One tool call's outcome: the envelope, and the error code when it failed. */
export interface Called {
  readonly ok: boolean;
  readonly code: string | null;
  readonly body: Record<string, unknown>;
}

export interface SkillWorld {
  readonly world: World;
  /** Calls one tool on a connected in-process client. */
  call(name: string, args?: Record<string, unknown>): Promise<Called>;
  /** Input JSON schema properties of a tool, as the client sees them. */
  inputKeys(name: string): Promise<string[]>;
  /** Closes the client and removes the world. */
  close(): Promise<void>;
}

/**
 * A world whose league file is a private copy of the fixture league at <config>/league.yaml (0600,
 * mtime a day before the clock — the provider stamps as_of from it), optionally rewritten by
 * `edit` (each [from, to] must occur).
 */
export async function skillWorld(
  clock: string,
  edit: readonly (readonly [string, string])[] = [],
): Promise<SkillWorld> {
  const world = await makeWorld({ noLeague: true, clock });
  const file = path.join(world.root, "config", "league.yaml");
  let yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  for (const [from, to] of edit) {
    if (!yaml.includes(from)) throw new Error(`fixture league has no ${JSON.stringify(from)}`);
    yaml = yaml.replace(from, to);
  }
  writeFileSync(file, yaml);
  chmodSync(file, 0o600);
  const before = new Date(Date.parse(clock) - 86_400_000);
  utimesSync(file, before, before);
  const { client, close } = await connect(world);
  return {
    world,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const b = body(r);
      const err = r.isError === true;
      return {
        ok: !err,
        code: err ? ((b as { error?: { code?: string } }).error?.code ?? "UNKNOWN") : null,
        body: b,
      };
    },
    async inputKeys(name) {
      const t = (await client.listTools()).tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`no tool ${name}`);
      return Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
    },
    async close() {
      await close();
      world.cleanup();
    },
  };
}

/** `data` of a successful call (throws on an error result, naming the code). */
export function dataOf(c: Called): Record<string, unknown> {
  if (!c.ok)
    throw new Error(`tool failed: ${c.code ?? "?"} ${JSON.stringify(c.body).slice(0, 300)}`);
  return c.body.data as Record<string, unknown>;
}

/**
 * Resolves a documented field path (`a.b`, `a[].b`) on a value: `[]` maps over an array. Returns
 * the values found (empty when the path does not exist).
 */
export function resolvePath(value: unknown, dotted: string): unknown[] {
  let cur: unknown[] = [value];
  for (const raw of dotted.split(".")) {
    const isList = raw.endsWith("[]");
    const key = isList ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
      if (!Object.hasOwn(v, key)) continue;
      const x = (v as Record<string, unknown>)[key];
      if (isList) {
        if (Array.isArray(x)) next.push(...(x as unknown[]));
      } else next.push(x);
    }
    cur = next;
  }
  return cur;
}

/** Every object key anywhere inside `value`. */
export function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

/** Every string value anywhere inside `value`. */
export function stringsDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) stringsDeep(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) stringsDeep(v, out);
  return out;
}

/** The backticked spans of a Markdown text, in order. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
}

/** The section of a Markdown document under the heading line `heading` (up to the next heading of the same or higher level). */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) throw new Error(`no heading ${heading}`);
  const level = (/^#+/.exec(heading) ?? [""])[0].length;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^(#+)\s/.exec(l);
    if (m !== null && (m[1] ?? "").length <= level) break;
    out.push(l);
  }
  return out.join("\n");
}

/** Plain sentences of a Markdown text: code fences dropped, emphasis and backticks removed. */
export function sentences(markdown: string): string[] {
  const text = markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/[`*]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z("])/)
    .map((s) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((s) => s !== "");
}
