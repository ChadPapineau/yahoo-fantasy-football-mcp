// define.ts — the one registration helper (plan 01 §4: `defineTool()` — annotations by family
// §4.1, the §4.2 envelope + outputSchema except the plan 07 C10 list tools, the §4.3 coded errors via
// deferValidation + wrapHandler, the ≤ 45-char untrusted-text pointer ending every description,
// plan 02 §6.3) and the output-budget/validation step every tool result passes through.
import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  ANALYTICS_BUDGET_CHARS,
  RESULT_BUDGET_CHARS,
  TRUNCATION_HINTS,
  UNTRUSTED_POINTER,
  buildEnvelope,
  envelopeSchema,
  fitToBudget,
  toToolResult,
  type InputStamp,
  type PageInfo,
  type ToolSuccessResult,
  type UntrustedField,
} from "./envelope.js";
import { FfError, describeForLog, wrapHandler, type HandlerContext } from "./errors.js";
import type { McpLogger, McpServerOptions, McpServices } from "./services.js";

/** Tool families (plan 01 §4.1 table; plan 07 §2 "Annotations"). */
export type ToolFamily = "platform" | "analytics" | "external" | "local_write" | "ops";

/** The annotations each family carries — no per-tool exceptions (plan 07 §2). */
export const FAMILY_ANNOTATIONS: Readonly<Record<ToolFamily, ToolAnnotations>> = Object.freeze({
  platform: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  analytics: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  external: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  local_write: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  ops: { readOnlyHint: true, openWorldHint: false },
});

/** The tool-name grammar (plan 01 §4.1): `ff_<verb>_<resource>`, ≤ 40 chars. */
export const TOOL_NAME_GRAMMAR = /^ff_[a-z][a-z0-9_]{1,36}$/;

/** What a tool implementation hands back: the envelope's inputs, not the envelope itself. */
export interface ToolOutput<D> {
  readonly data: D;
  /** Contributing inputs (platform + dataset stamps), converted with stampToInput. */
  readonly inputs: readonly InputStamp[];
  readonly extraSources?: readonly string[];
  readonly provisional?: boolean;
  readonly estimate?: boolean;
  readonly bareFields?: readonly UntrustedField[];
  readonly page?: PageInfo;
  readonly warnings?: readonly string[];
  /** The array under `data` the budget may halve (list tools, analytics candidate lists). */
  readonly listKey?: string;
}

/** Per-call context a tool implementation receives. */
export interface ToolContext extends HandlerContext {
  /** The call's instant, read once from the injected Clock. */
  readonly nowMs: number;
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly log: McpLogger;
  /** Per-call memo (league, universe, …) so one call never reads a port twice. */
  readonly memo: Map<string, unknown>;
}

/** One tool's definition. */
export interface ToolDefinition<S extends z.ZodType, D> {
  readonly name: string;
  readonly family: ToolFamily;
  /** The static description (no dynamic text — plan 07 §5.4); the pointer is appended here. */
  readonly description: string;
  readonly input: S;
  /** The `data` schema (→ outputSchema); null for the plan 07 C10 list tools (no outputSchema). */
  readonly data: z.ZodType<D> | null;
  /** Which budget applies (plan 01 §4.2 20 000 chars; plan 07 C8 10 000 for analytics). */
  readonly budget: "list" | "analytics";
  /** Whether the list under `listKey` pages with offset (list tools) or is only halved. */
  readonly pageable?: boolean;
  /** The truncation warning's fixed advice. */
  readonly hint?: string;
  /** Top-level arguments advertised as opaque objects (property → where the value comes from). */
  readonly opaqueInput?: Readonly<Record<string, string>>;
  readonly run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutput<D>>;
}

/** A definition with its generics erased (the registry's element type). */
export interface AnyToolDefinition {
  readonly name: string;
  readonly family: ToolFamily;
  readonly description: string;
  readonly input: z.ZodType;
  readonly data: z.ZodType | null;
  readonly budget: "list" | "analytics";
  readonly pageable?: boolean;
  readonly hint?: string;
  readonly opaqueInput?: Readonly<Record<string, string>>;
  readonly run: (args: never, ctx: ToolContext) => Promise<ToolOutput<unknown>>;
}

/** Identity with inference: `defineTool({...})` type-checks `run` against `input` and `data`. */
export function defineTool<S extends z.ZodType, D>(def: ToolDefinition<S, D>): AnyToolDefinition {
  if (!TOOL_NAME_GRAMMAR.test(def.name)) throw new RangeError("define: invalid tool name");
  return def;
}

/** The description as registered: static text + one space + the pointer (always last). */
export function fullDescription(description: string): string {
  const d = description.trim();
  return d.endsWith(UNTRUSTED_POINTER) ? d : `${d} ${UNTRUSTED_POINTER}`;
}

// --- the advertised schemas (plan 07 C3/C10/§5.1: definitions are paid every turn) ------------------

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [k: string]: Json;
}

const TARGET = "draft-2020-12" as const;

/**
 * Shrinks an advertised INPUT schema without tightening it: `$schema`, every `pattern` and
 * `additionalProperties: false` go (the key grammars are long regexes; keys come from other tools'
 * results, and the server re-validates every argument with the full strict zod schema — a failure,
 * an unknown key included, is a coded VALIDATION/INVALID_KEY result). Bounds, enums, formats,
 * defaults and `required` stay: they guide the model.
 */
export function compactJsonSchema(node: Json): Json {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "pattern") continue;
    if (k === "additionalProperties" && v === false) continue;
    out[k] = compactJsonSchema(v);
  }
  return out;
}

function isObj(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The advertised OUTPUT schema: the envelope with `data`'s top-level field names — a superset of
 * the zod contract (every result is validated against the full zod schema
 * before it leaves the server, and the SDK re-validates it). The field-level shape of every tool is
 * documented in `ff://docs/tool-outputs` (plan 07 C10's mechanism, applied to the depth below data).
 */
export function envelopeOutline(data: z.ZodType): JsonObject {
  const json = z.toJSONSchema(data, { target: TARGET, io: "output" }) as Json;
  const props: JsonObject = {};
  if (isObj(json) && isObj(json.properties))
    for (const k of Object.keys(json.properties)) props[k] = {};
  return {
    type: "object",
    properties: { data: { type: "object", properties: props }, meta: { type: "object" } },
    required: ["data", "meta"],
  };
}

/**
 * A Standard Schema for the SDK that validates with `schema` (zod) but advertises `json` — used for
 * outputSchema (the SDK checks every structured result against the full zod contract).
 */
export function advertised(
  schema: z.ZodType,
  json: () => JsonObject,
): StandardSchemaWithJSON<unknown, unknown> {
  const std = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  let cached: JsonObject | null = null;
  const get = (): JsonObject => (cached ??= json());
  return {
    "~standard": {
      version: 1,
      vendor: "ff-advertised",
      validate: (value: unknown) => std.validate(value),
      jsonSchema: { input: get, output: get },
    },
  };
}

/** The outputSchema of a tool whose `data` is `data`: validates the full envelope, advertises the outline. */
export function advertisedOutputSchema(data: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  return advertised(envelopeSchema(data), () => envelopeOutline(data));
}

/**
 * The inputSchema of a tool: every argument passes through unvalidated (validation happens in
 * wrapHandler — plan 01 §4.3 coded errors), advertising the compacted JSON Schema; `opaque`
 * top-level properties are advertised as bare objects/arrays with a pointer to where they come from.
 */
export function advertisedInputSchema(
  schema: z.ZodType,
  opaque: Readonly<Record<string, string>> = {},
): StandardSchemaWithJSON<unknown, unknown> {
  let cached: JsonObject | null = null;
  const get = (): JsonObject => {
    if (cached !== null) return cached;
    const json = compactJsonSchema(z.toJSONSchema(schema, { target: TARGET, io: "input" }) as Json);
    const out: JsonObject = isObj(json) ? { ...json } : { type: "object" };
    if (isObj(out.properties)) {
      const props: JsonObject = { ...out.properties };
      for (const [k, description] of Object.entries(opaque)) {
        const p = props[k];
        props[k] = { type: isObj(p) && p.type === "array" ? "array" : "object", description };
      }
      out.properties = props;
    }
    cached = out;
    return out;
  };
  return {
    "~standard": {
      version: 1,
      vendor: "ff-deferred",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: get, output: get },
    },
  };
}

// --- registration ----------------------------------------------------------------------------------

/** The full output schema of a tool (envelope around its `data`), or null for C10 list tools. */
export function outputSchemaOf(def: AnyToolDefinition): z.ZodType | null {
  return def.data === null ? null : envelopeSchema(def.data);
}

/** Decimals analytics numbers are rounded to on output (plan 07 C8 budget; monotone, so quantiles stay ordered). */
export const ANALYTICS_DECIMALS = 3;

/** Rounds every non-integer number in a JSON-shaped value to `decimals` places (−0 → 0). */
export function roundDeep(v: unknown, decimals: number = ANALYTICS_DECIMALS): unknown {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || Number.isInteger(v)) return v;
    const f = 10 ** decimals;
    const r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;
  }
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, decimals));
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = roundDeep(x, decimals);
    return out;
  }
  return v;
}

/** Runs a tool body and turns its output into the tool result (budget, validation, structure). */
export async function runTool(
  def: AnyToolDefinition,
  args: unknown,
  base: HandlerContext,
  services: McpServices,
  options: McpServerOptions,
  full: z.ZodType | null,
): Promise<ToolSuccessResult> {
  const log = services.logger;
  services.beforeCall?.();
  const ctx: ToolContext = {
    requestId: base.requestId,
    nowMs: services.clock.nowMs(),
    services,
    options,
    log,
    memo: new Map(),
  };
  const out = await def.run(args as never, ctx);
  const env = buildEnvelope({
    data: def.budget === "analytics" ? roundDeep(out.data) : out.data,
    requestId: ctx.requestId,
    nowMs: ctx.nowMs,
    inputs: out.inputs,
    ...(out.extraSources === undefined ? {} : { extraSources: out.extraSources }),
    ...(out.provisional === undefined ? {} : { provisional: out.provisional }),
    ...(out.estimate === undefined ? {} : { estimate: out.estimate }),
    ...(out.bareFields === undefined ? {} : { bareFields: out.bareFields }),
    ...(out.page === undefined ? {} : { page: out.page }),
    ...(out.warnings === undefined ? {} : { warnings: out.warnings }),
  });
  const budget = def.budget === "analytics" ? ANALYTICS_BUDGET_CHARS : RESULT_BUDGET_CHARS;
  const hint =
    def.hint ?? (def.budget === "analytics" ? TRUNCATION_HINTS.analytics : TRUNCATION_HINTS.list);
  const fit = fitToBudget(env, budget, out.listKey, { pageable: def.pageable === true, hint });
  if (!fit.ok) {
    log.error("tool.over_budget", { request_id: ctx.requestId, tool: def.name, size: fit.size });
    throw new FfError("INTERNAL");
  }
  if (full !== null) {
    const parsed = full.safeParse(JSON.parse(JSON.stringify(fit.envelope)));
    if (!parsed.success) {
      log.error("tool.output_invalid", {
        request_id: ctx.requestId,
        tool: def.name,
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path, code: i.code })),
      });
      throw new FfError("INTERNAL");
    }
  }
  return toToolResult(fit.envelope, full !== null);
}

/** Registers one tool on `server` with everything plan 01 §4 requires. */
export function registerDefinedTool(
  server: McpServer,
  def: AnyToolDefinition,
  services: McpServices,
  options: McpServerOptions,
): void {
  const full = outputSchemaOf(def);
  const log = services.logger;
  const handler = wrapHandler(
    def.input,
    (args, base) => runTool(def, args, base, services, options, full),
    {
      onError: (e, requestId) => {
        log.warn("tool.error", { request_id: requestId, tool: def.name, error: describeForLog(e) });
      },
    },
  );
  server.registerTool(
    def.name,
    {
      description: fullDescription(def.description),
      inputSchema: advertisedInputSchema(def.input, def.opaqueInput),
      ...(def.data === null ? {} : { outputSchema: advertisedOutputSchema(def.data) }),
      annotations: FAMILY_ANNOTATIONS[def.family],
    },
    handler,
  );
}
