// resources/index.ts — the Phase-1a `ff://` resources (plan 07 §4.1; plan 10 §3.1a): ff://league,
// ff://league/settings, ff://status, ff://status/freshness, ff://docs/tool-outputs,
// ff://rec/{log_id}, ff://rec/week/{week}. Each is a read-side twin of tool data with the same
// envelope, a fixed `ttlMs` (RESOURCE_TTL_MS, critic C-19) and `cacheScope: "private"`; log text read
// back is path-listed with `store.recommendation_log` (OBJ-15). Failures come back as the coded error
// body (never a free-text message); an unknown log id or week is ResourceNotFound without an echo.
import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { LOG_ID_RE, RECOMMENDATION_KINDS } from "../../domain/reclog/types.js";
import type { ToolContext } from "../define.js";
import {
  RESOURCE_TTL_MS,
  RESULT_BUDGET_CHARS,
  TRUNCATION_HINTS,
  UNTRUSTED_TEXT_RULE,
  bareUntrusted,
  buildEnvelope,
  fitToBudget,
  serializeEnvelope,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { FfError, describeForLog, newRequestId, toToolError } from "../errors.js";
import type { McpServerOptions, McpServices } from "../services.js";
import { bare, leagueContext } from "../tools/common.js";
import { leagueDigest } from "../tools/league.js";
import { freshnessReport, statusSnapshot } from "../tools/ops.js";
import { REC_SOURCE, recordTextFields, recordView } from "../tools/reclog.js";

/** What a resource body returns (the envelope's inputs). */
interface ResourceOutput {
  readonly data: unknown;
  readonly inputs: readonly InputStamp[];
  readonly warnings?: readonly string[];
  readonly bareFields?: readonly UntrustedField[];
  readonly extraSources?: readonly string[];
  readonly listKey?: string;
}

const JSON_MIME = "application/json";

/** Fallback cheat-sheet when the package's copy is missing: still carries the rule sentence (C13). */
export const TOOL_OUTPUTS_FALLBACK = `## Tool outputs\n\nThe cheat-sheet file was not found in this installation; each tool's outputSchema documents its data.\n\n> ${UNTRUSTED_TEXT_RULE}\n`;

/** The ff://docs/tool-outputs text: the package's cheat-sheet, always carrying the rule sentence. */
export function toolOutputsText(options: McpServerOptions): string {
  const t = options.texts.tool_outputs;
  if (t === null || t.trim() === "") return TOOL_OUTPUTS_FALLBACK;
  return t.includes(UNTRUSTED_TEXT_RULE) ? t : `${t}\n\n> ${UNTRUSTED_TEXT_RULE}\n`;
}

/** Runs a resource body into one JSON content block (envelope, or the coded error body). */
async function readAsEnvelope(
  uri: string,
  services: McpServices,
  options: McpServerOptions,
  body: (ctx: ToolContext) => Promise<ResourceOutput>,
): Promise<ReadResourceResult> {
  const requestId = newRequestId();
  try {
    services.beforeCall?.();
    const ctx: ToolContext = {
      requestId,
      nowMs: services.clock.nowMs(),
      services,
      options,
      log: services.logger,
      memo: new Map(),
    };
    const out = await body(ctx);
    const env = buildEnvelope({
      data: out.data,
      requestId,
      nowMs: ctx.nowMs,
      inputs: out.inputs,
      ...(out.warnings === undefined ? {} : { warnings: out.warnings }),
      ...(out.bareFields === undefined ? {} : { bareFields: out.bareFields }),
      ...(out.extraSources === undefined ? {} : { extraSources: out.extraSources }),
    });
    const fit = fitToBudget(env, RESULT_BUDGET_CHARS, out.listKey, {
      pageable: false,
      hint: TRUNCATION_HINTS.list,
    });
    if (!fit.ok) throw new FfError("INTERNAL");
    return { contents: [{ uri, mimeType: JSON_MIME, text: serializeEnvelope(fit.envelope) }] };
  } catch (e) {
    if (e instanceof ResourceNotFoundError) throw e;
    services.logger.warn("resource.error", { request_id: requestId, error: describeForLog(e) });
    return {
      contents: [{ uri, mimeType: JSON_MIME, text: toToolError(e, requestId).content[0].text }],
    };
  }
}

const hint = (uri: keyof typeof RESOURCE_TTL_MS) =>
  ({ ttlMs: RESOURCE_TTL_MS[uri], cacheScope: "private" }) as const;

/** The ff://league/settings envelope text, or null when it cannot be read (prompts embed it). */
export async function leagueSettingsText(
  services: McpServices,
  options: McpServerOptions,
): Promise<string | null> {
  const r = await readAsEnvelope("ff://league/settings", services, options, (ctx) =>
    leagueDigest(ctx, {}),
  );
  const c = r.contents[0];
  const text = c !== undefined && "text" in c && typeof c.text === "string" ? c.text : null;
  return text === null || text.startsWith('{"error"') ? null : text;
}

/** Registers every Phase-1a resource. */
export function registerResources(
  server: McpServer,
  services: McpServices,
  options: McpServerOptions,
): void {
  server.registerResource(
    "league",
    "ff://league",
    {
      description: "The configured league identity: league_key, my team_key, season.",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://league"),
    },
    (uri) =>
      readAsEnvelope(uri.href, services, options, async (ctx) => {
        const lc = await leagueContext(ctx, {});
        return {
          data: {
            league_key: lc.ref.league_key,
            team_key: lc.league.my_team?.team_key ?? null,
            season: lc.league.season,
          },
          inputs: [lc.input],
        };
      }),
  );

  server.registerResource(
    "league_settings",
    "ff://league/settings",
    {
      description: "The league settings digest (same data as ff_get_league).",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://league/settings"),
    },
    (uri) => readAsEnvelope(uri.href, services, options, async (ctx) => leagueDigest(ctx, {})),
  );

  server.registerResource(
    "status",
    "ff://status",
    {
      description: "Server status (ff_get_status without checks).",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://status"),
    },
    (uri) =>
      readAsEnvelope(uri.href, services, options, async (ctx) => {
        const r = await statusSnapshot(ctx, false);
        return {
          data: r.data,
          inputs: r.inputs,
          warnings: r.warnings,
          ...(r.nameSource === null
            ? {}
            : {
                bareFields: [
                  bare("data.crosswalk.unmatched_rostered[].name", r.nameSource),
                  bare("data.crosswalk.unmatched_top_owned[].name", r.nameSource),
                ],
              }),
        };
      }),
  );

  server.registerResource(
    "status_freshness",
    "ff://status/freshness",
    {
      description: "The freshness report: each source's age and state, and the class table.",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://status/freshness"),
    },
    (uri) =>
      readAsEnvelope(uri.href, services, options, (ctx) =>
        Promise.resolve({ data: freshnessReport(ctx), inputs: [] }),
      ),
  );

  server.registerResource(
    "tool_outputs",
    "ff://docs/tool-outputs",
    {
      description: "The tool-output cheat-sheet (fields per tool; the untrusted-text rule).",
      mimeType: "text/markdown",
      cacheHint: hint("ff://docs/tool-outputs"),
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: toolOutputsText(options) }],
    }),
  );

  /** Completion over the configured league's 20 newest log ids (plan 07 §4.1 RFC 6570 completion). */
  const recentLogIds = async (value: string): Promise<string[]> => {
    try {
      const ref = (await services.platform.listMyLeagues()).value[0];
      if (ref === undefined) return [];
      return services.recommendationLog
        .list({
          league_key: ref.league_key,
          season: null,
          week: null,
          kind: null,
          limit: 20,
          offset: 0,
        })
        .items.map((i) => i.log_id)
        .filter((id) => id.startsWith(value));
    } catch {
      return [];
    }
  };

  server.registerResource(
    "rec",
    new ResourceTemplate("ff://rec/{log_id}", {
      list: undefined,
      complete: { log_id: recentLogIds },
    }),
    {
      description: "One recommendation-log entry (its free text is untrusted).",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://rec/{log_id}"),
    },
    (uri, variables) => {
      const raw = variables.log_id;
      const id = typeof raw === "string" ? raw : "";
      if (!LOG_ID_RE.test(id)) throw new ResourceNotFoundError("ff://rec/{log_id}", "not found");
      return readAsEnvelope(uri.href, services, options, async (ctx) => {
        const lc = await leagueContext(ctx, {});
        const r = ctx.services.recommendationLog.get(id);
        if (r?.league_key !== lc.ref.league_key)
          throw new ResourceNotFoundError("ff://rec/{log_id}", "not found");
        return {
          data: recordView(r),
          inputs: [lc.input],
          bareFields: recordTextFields("data"),
          extraSources: [REC_SOURCE],
        };
      });
    },
  );

  server.registerResource(
    "rec_week",
    new ResourceTemplate("ff://rec/week/{week}", {
      list: undefined,
      complete: {
        week: (value) =>
          Array.from({ length: 22 }, (_, i) => String(i + 1)).filter((w) => w.startsWith(value)),
      },
    }),
    {
      description: "The current season's log entries for one week, summary form (untrusted text).",
      mimeType: JSON_MIME,
      cacheHint: hint("ff://rec/week/{week}"),
    },
    (uri, variables) => {
      const raw = variables.week;
      const w = typeof raw === "string" && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!(Number.isInteger(w) && w >= 1 && w <= 22))
        throw new ResourceNotFoundError("ff://rec/week/{week}", "not found");
      return readAsEnvelope(uri.href, services, options, async (ctx) => {
        const lc = await leagueContext(ctx, {});
        const page = ctx.services.recommendationLog.list({
          league_key: lc.ref.league_key,
          season: lc.league.season,
          week: w,
          kind: null,
          limit: 100,
          offset: 0,
        });
        const items = page.items
          .filter((i) => (RECOMMENDATION_KINDS as readonly string[]).includes(i.kind))
          .map((i) => ({ ...i, action_summary: bareUntrusted(i.action_summary, "rec_log_text") }));
        return {
          data: { week: w, items },
          inputs: [lc.input],
          bareFields: [bare("data.items[].action_summary", REC_SOURCE)],
          extraSources: [REC_SOURCE],
          listKey: "items",
        };
      });
    },
  );
}
