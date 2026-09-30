// eslint.config.js — ESLint flat config. Implements docs/plan/04 §3 (R3: typescript-eslint
// strictTypeChecked + stylisticTypeChecked, no-console outside src/cli, import boundaries) and the
// layer table of docs/plan/01 §1.1; bans shell-string child_process and eval (plan 02 §7, plan 04 §2).
//
// Boundaries are enforced TWICE, on purpose:
//   1. `ff/layer-boundaries` (local rule below) resolves every relative specifier LEXICALLY, so it
//      cannot be fooled by an import whose target does not exist yet or that a resolver misses.
//   2. `import-x/no-restricted-paths` (plan 04 A-5), fed the same table. It resolves through the
//      filesystem and silently SKIPS an import it cannot resolve — which is why (1) exists.
// tests/lint/boundaries.test.ts proves both fire on an illegal import and stay quiet on a legal one.
import path from "node:path";
import tseslint from "typescript-eslint";
import { importX, createNodeResolver } from "eslint-plugin-import-x";

const ROOT = import.meta.dirname;

/**
 * Layer -> layers it must never import (plan 01 §1.1). Layer = first directory under src/;
 * `cli-entry` is src/cli.ts; `root` is any other file directly in src/ (e.g. version.ts).
 * Decisions where plan 01 is broader than a buildable rule are recorded in CHANGELOG/decisions:
 * `store` may import `domain` (repository contracts/types) and `config`.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const FORBIDDEN_LAYERS = Object.freeze({
  domain: ["providers", "sources", "store", "mcp", "auth", "http", "cli", "cli-entry"],
  mcp: ["store", "cli", "cli-entry"],
  providers: ["mcp", "cli", "cli-entry"],
  sources: ["mcp", "providers", "cli", "cli-entry"],
  store: ["mcp", "providers", "sources", "auth", "http", "cli", "cli-entry"],
  auth: ["mcp", "domain", "cli", "cli-entry"],
  http: ["mcp", "domain", "store", "cli", "cli-entry"],
  config: ["mcp", "domain", "providers", "sources", "store", "auth", "http", "cli", "cli-entry"],
  root: ["cli", "cli-entry"],
  cli: ["cli-entry"],
  "cli-entry": [],
});

/** Layers that nobody may import (the CLI is the top of the graph). */
const TOP_ONLY = new Set(["cli", "cli-entry"]);

/**
 * @param {string} rel a POSIX path relative to the repo root
 * @returns {string | null} the layer, or null when the path is not under src/
 */
export function layerOf(rel) {
  if (!rel.startsWith("src/")) return null;
  const rest = rel.slice("src/".length);
  if (rest === "cli.ts" || rest === "cli.js") return "cli-entry";
  const slash = rest.indexOf("/");
  return slash === -1 ? "root" : rest.slice(0, slash);
}

/**
 * The same table as import-x zones (paths relative to basePath).
 * @returns {{ target: string[], from: string[], message: string }[]}
 */
export function boundaryZones() {
  /** @param {string} layer */
  const dirOf = (layer) => (layer === "cli-entry" ? "./src/cli.ts" : `./src/${layer}`);
  return Object.entries(FORBIDDEN_LAYERS)
    .filter(([, banned]) => banned.length > 0)
    .map(([layer, banned]) => ({
      target: layer === "root" ? ["./src/version.ts"] : [dirOf(layer)],
      from: banned.map(dirOf),
      message: `plan 01 §1.1: src/${layer} may not import ${banned.join(", ")}.`,
    }));
}

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/** @type {import("eslint").Rule.RuleModule} */
const layerBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "Enforce the plan 01 §1.1 layer table by lexical path resolution." },
    schema: [
      {
        type: "object",
        properties: { root: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      layer: "src/{{from}} may not import src/{{to}} ('{{spec}}') — plan 01 §1.1.",
      top: "Nothing may import the CLI layer ('{{spec}}') — plan 01 §1.1.",
      outside: "Code under src/ may not import outside src/ ('{{spec}}'): it would not ship.",
      alias:
        "Subpath-import aliases ('{{spec}}') are not allowed under src/: use a relative path so the layer table can see the target.",
    },
  },
  create(context) {
    const opts = /** @type {{ root?: string } | undefined} */ (context.options[0]);
    const root = opts?.root ?? ROOT;
    const file = context.physicalFilename;
    const fromRel = toPosix(path.relative(root, file));
    const fromLayer = layerOf(fromRel);
    if (fromLayer === null) return {};
    const banned = new Set(FORBIDDEN_LAYERS[fromLayer] ?? [...TOP_ONLY]);

    /**
     * @param {import("estree").Node} node
     * @param {unknown} spec
     */
    function check(node, spec) {
      if (typeof spec !== "string") return;
      if (spec.startsWith("#")) {
        // package.json "imports" aliases would hide the target layer from this rule
        context.report({ node, messageId: "alias", data: { spec } });
        return;
      }
      if (!spec.startsWith(".") && !spec.startsWith("/")) return; // bare specifiers: no-restricted-imports
      const target = toPosix(path.relative(root, path.resolve(path.dirname(file), spec)));
      const toLayer = layerOf(target);
      if (toLayer === null) {
        context.report({ node, messageId: "outside", data: { spec } });
        return;
      }
      if (toLayer === fromLayer) return;
      if (TOP_ONLY.has(toLayer) && !(fromLayer === "cli-entry" && toLayer === "cli")) {
        context.report({ node, messageId: "top", data: { spec } });
        return;
      }
      if (banned.has(toLayer)) {
        context.report({ node, messageId: "layer", data: { from: fromLayer, to: toLayer, spec } });
      }
    }

    return {
      ImportDeclaration: (n) => check(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
      ExportAllDeclaration: (n) => check(n, n.source.value),
      ImportExpression: (n) => n.source.type === "Literal" && check(n, n.source.value),
      /** @param {any} n TSImportType (`import("x").T`) — not in the estree types; `source` is the
       *  specifier literal (typescript-eslint 8.x deprecates `argument`) */
      TSImportType(n) {
        if (n.source?.type === "Literal") check(n, n.source.value);
      },
    };
  },
};

const CHILD_PROCESS = ["child_process", "node:child_process"];
const EXEC_BAN = CHILD_PROCESS.map((name) => ({
  name,
  importNames: ["exec", "execSync"],
  message: "Shell-string exec is banned: use execFile/spawn with an argument array (plan 02 §7).",
}));
const VM_BAN = ["vm", "node:vm"].map((name) => ({
  name,
  message: "node:vm evaluates code — banned like eval (plan 02 §7).",
}));
const FS_BAN = ["fs", "node:fs", "fs/promises", "node:fs/promises"].map((name) => ({
  name,
  message: "No filesystem access in this layer (plan 01 §1.1): take it through an injected port.",
}));
const DOMAIN_IO_BAN = [
  "child_process",
  "node:child_process",
  "sqlite",
  "node:sqlite",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "http2",
  "node:http2",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
].map((name) => ({ name, message: "src/domain is pure (plan 01 §1.1): no I/O modules." }));
const MCP_SDK_BAN = {
  regex: "^@modelcontextprotocol/",
  message: "src/domain may not import the MCP SDK (plan 01 §1.1).",
};

const SYNTAX_BANS = [
  {
    selector:
      "ImportDeclaration[source.value=/^(node:)?child_process$/] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)",
    message: "Import execFile/spawn by name from child_process — a namespace import reaches exec.",
  },
  {
    selector: "ImportExpression[source.value=/^(node:)?child_process$/]",
    message: "No dynamic import of child_process.",
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]",
    message: "No require of child_process.",
  },
  {
    selector: "CallExpression[callee.name=/^(exec|execSync)$/]",
    message: "Shell-string exec is banned (plan 02 §7).",
  },
  {
    selector: "MemberExpression[property.name='execSync']",
    message: "Shell-string execSync is banned (plan 02 §7).",
  },
  {
    selector:
      "CallExpression > ObjectExpression > Property[key.name='shell']:not([value.value=false])",
    message: "`shell` must be literally false: argument arrays only (plan 02 §7).",
  },
];

const FETCH_BAN = {
  globals: [{ name: "fetch", message: "No network from this layer (plan 01 §1.1): use src/http." }],
  properties: [
    {
      object: "globalThis",
      property: "fetch",
      message: "No network from this layer (plan 01 §1.1).",
    },
  ],
};

const STDOUT_BAN = [
  {
    object: "process",
    property: "stdout",
    message: "stdout carries MCP frames only (plan 01 §2).",
  },
];

/**
 * A bare `["error"]` would KEEP an earlier config object's options (flat-config merge rule), so an
 * empty ban list must be "off" to actually lift a ban.
 * @param {object[]} list
 * @returns {import("eslint").Linter.RuleEntry}
 */
const offIfEmpty = (list) => (list.length ? ["error", ...list] : "off");

/**
 * no-restricted-imports / -syntax / -properties replace (not merge) across config objects, so each
 * layer's object restates the global bans.
 * @param {{ paths?: object[], patterns?: object[], fetch?: boolean, stdout?: boolean, clock?: boolean }} extra
 * @returns {import("eslint").Linter.RulesRecord}
 */
function restrictions(extra) {
  return {
    "no-restricted-imports": [
      "error",
      { paths: [...EXEC_BAN, ...VM_BAN, ...(extra.paths ?? [])], patterns: extra.patterns ?? [] },
    ],
    "no-restricted-globals": offIfEmpty(extra.fetch ? FETCH_BAN.globals : []),
    "no-restricted-properties": offIfEmpty([
      ...(extra.stdout ? STDOUT_BAN : []),
      ...(extra.fetch ? FETCH_BAN.properties : []),
      ...(extra.clock ? CLOCK_BAN : []),
    ]),
  };
}

/**
 * src/domain is deterministic: randomness comes from the seeded Rng and time from the Clock in
 * src/domain/clock.ts (Stage A critique B C-17), so simulations and tests are reproducible.
 */
const CLOCK_BAN = [
  {
    object: "Math",
    property: "random",
    message:
      "src/domain must use the seeded Rng from src/domain/clock.ts, not Math.random (B C-17).",
  },
  {
    object: "Date",
    property: "now",
    message:
      "src/domain must take time from the injected Clock (src/domain/clock.ts), not Date.now.",
  },
];

const TS_FILES = ["**/*.ts", "**/*.mts", "**/*.cts"];
const JS_FILES = ["**/*.js", "**/*.mjs", "**/*.cjs"];

/** Node's globals for plain-JS tooling (scripts/**) — written out to avoid a `globals` dependency. */
const NODE_GLOBALS = Object.fromEntries(
  [
    "AbortController",
    "AbortSignal",
    "Buffer",
    "URL",
    "URLSearchParams",
    "TextDecoder",
    "TextEncoder",
    "clearInterval",
    "clearTimeout",
    "console",
    "fetch",
    "globalThis",
    "process",
    "queueMicrotask",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "structuredClone",
    "performance",
    "Response",
    "Request",
    "Headers",
  ].map((g) => [g, "readonly"]),
);

const scope = (/** @type {object[]} */ configs) => configs.map((c) => ({ ...c, files: TS_FILES }));

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "docs/**",
      "scripts/docs-check-selftest/**",
      "scripts/gitleaks-selftest/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  // --- TypeScript: type-checked strict + stylistic --------------------------------------------
  ...scope(tseslint.configs.strictTypeChecked),
  ...scope(tseslint.configs.stylisticTypeChecked),
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: ROOT },
    },
    plugins: { "import-x": importX, ff: { rules: { "layer-boundaries": layerBoundaries } } },
    settings: {
      "import-x/resolver-next": [
        createNodeResolver({
          extensions: [".ts", ".mts", ".js", ".mjs", ".json"],
          extensionAlias: { ".js": [".ts", ".js"], ".mjs": [".mts", ".mjs"] },
          conditionNames: ["import", "node", "default"],
        }),
      ],
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": ["error", ...SYNTAX_BANS],
      ...restrictions({}),
      "ff/layer-boundaries": ["error", { root: ROOT }],
      "import-x/no-restricted-paths": ["error", { basePath: ROOT, zones: boundaryZones() }],
    },
  },

  // --- stdout discipline: no console / process.stdout in src/ except the CLI (plan 01 §2) --------
  { files: ["src/**/*.ts"], rules: { "no-console": "error", ...restrictions({ stdout: true }) } },
  { files: ["src/cli/**/*.ts", "src/cli.ts"], rules: { "no-console": "off", ...restrictions({}) } },

  // --- layer-specific import bans (plan 01 §1.1) --------------------------------------------------
  {
    files: ["src/domain/**/*.ts"],
    rules: restrictions({
      paths: [...FS_BAN, ...DOMAIN_IO_BAN],
      patterns: [MCP_SDK_BAN],
      fetch: true,
      stdout: true,
      clock: true,
    }),
  },
  {
    // the one sanctioned reader of wall-clock time in src/domain (systemClock)
    files: ["src/domain/clock.ts"],
    rules: restrictions({
      paths: [...FS_BAN, ...DOMAIN_IO_BAN],
      patterns: [MCP_SDK_BAN],
      fetch: true,
      stdout: true,
    }),
  },
  {
    files: ["src/mcp/**/*.ts"],
    rules: restrictions({ paths: FS_BAN, fetch: true, stdout: true }),
  },

  // --- tests: vitest idioms ----------------------------------------------------------------------
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },

  // --- plain-JS tooling (scripts/**, config files): Node globals, core correctness rules --------
  {
    files: JS_FILES,
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: NODE_GLOBALS },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-const-assign": "error",
      "no-self-assign": "error",
      "no-redeclare": "error",
      "no-fallthrough": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": ["error", { paths: [...EXEC_BAN, ...VM_BAN] }],
      "no-restricted-syntax": ["error", ...SYNTAX_BANS],
    },
  },
];
