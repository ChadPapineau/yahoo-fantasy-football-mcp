// prompts/index.ts — the Phase-1a prompts (plan 07 §4.2; plan 10 §3.1a): ff.start_sit [week],
// ff.stream <K|DEF>, ff.retro [week]. Each returns the Skill body (read from skills/<name>/SKILL.md
// by the composition root) as the user message, the embedded ff://league/settings resource, and the
// plan 02 §6.3 untrusted-text sentence (plan 01 §4.1: prompts state the rule). No logic, no tools.
import type { GetPromptResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { UNTRUSTED_TEXT_RULE } from "../envelope.js";
import { leagueSettingsText } from "../resources/index.js";
import type { McpServerOptions, McpServices, ServerTexts } from "../services.js";

/** A week argument as prompts carry it (strings): 1..22. */
const weekArg = z
  .string()
  .regex(/^(?:[1-9]|1\d|2[0-2])$/)
  .optional();

/** The Phase-1a prompt table: name → Skill text key and argument schema. */
export const PROMPTS = Object.freeze([
  {
    name: "ff.start_sit",
    skill: "start_sit" as const,
    description: "Start/sit for a week (the start-sit Skill): lineup, locks, coin flips, the log.",
    args: z.object({ week: weekArg }),
  },
  {
    name: "ff.stream",
    skill: "stream" as const,
    description: "Stream a kicker or defence (the stream-kdef Skill).",
    args: z.object({ position: z.enum(["K", "DEF"]) }),
  },
  {
    name: "ff.retro",
    skill: "retro" as const,
    description: "Score last week's logged calls (the retro Skill).",
    args: z.object({ week: weekArg }),
  },
]);

/** The prompt's user text: the rule, the Skill body, and the arguments as plain key=value. */
export function promptText(
  texts: ServerTexts,
  skill: "start_sit" | "stream" | "retro",
  args: Readonly<Record<string, string | undefined>>,
): string {
  const body =
    texts[skill] ?? "This Skill's body is not installed; follow the tool descriptions directly.";
  const argLine = Object.entries(args)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${UNTRUSTED_TEXT_RULE}\n\n${body.trim()}${argLine === "" ? "" : `\n\nArguments: ${argLine}`}\n`;
}

/** Registers the three Phase-1a prompts. */
export function registerPrompts(
  server: McpServer,
  services: McpServices,
  options: McpServerOptions,
): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { description: p.description, argsSchema: p.args },
      async (args: Readonly<Record<string, string | undefined>>): Promise<GetPromptResult> => {
        const messages: GetPromptResult["messages"] = [
          {
            role: "user",
            content: { type: "text", text: promptText(options.texts, p.skill, args) },
          },
        ];
        const settings = await leagueSettingsText(services, options);
        if (settings !== null)
          messages.push({
            role: "user",
            content: {
              type: "resource",
              resource: {
                uri: "ff://league/settings",
                mimeType: "application/json",
                text: settings,
              },
            },
          });
        return { description: p.description, messages };
      },
    );
  }
}
