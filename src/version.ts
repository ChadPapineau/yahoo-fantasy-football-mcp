// The server's version string (docs/plan/04 §1 package layout; plan 04 §4.4 release tags). Kept in
// step with package.json "version" — tests/lint/version.test.ts fails when they differ.
export const VERSION = "0.0.0" as const;
