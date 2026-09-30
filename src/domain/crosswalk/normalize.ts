// normalize.ts — name and id normalisation for the crosswalk matcher: research 04 §D step 2
// (DynastyProcess `merge_name`: lowercase, strip punctuation + Jr/Sr/II–V suffixes, ASCII-fold) and
// §D "known defects" (Sleeper leading-space gsis ids, DynastyProcess `NA`); plan 05 §2 domain/crosswalk.
import { GSIS_ID_RE } from "../../config/schema.js";

/** Longest raw name the normaliser accepts; anything longer is not a name (bounded work). */
export const MAX_NAME_CHARS = 128;

/** Longest raw id `cleanId` accepts. */
export const MAX_ID_CHARS = 64;

/** Generational suffixes stripped from the END of a name (never from the front, never to one token). */
export const NAME_SUFFIXES: readonly string[] = Object.freeze(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Latin letters NFKD does not decompose, folded to ASCII. Anything else that is not ASCII after
 * folding (Cyrillic/Greek homoglyphs, zero-width and format characters, symbols) makes the name
 * unnormalisable — rejected, never merged.
 */
const LETTER_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  đ: "d",
  ð: "d",
  ł: "l",
  ı: "i",
  ħ: "h",
  þ: "th",
});
const FOLDS: readonly (readonly [string, string])[] = Object.entries(LETTER_FOLDS);

/** Apostrophe-like marks, removed without a space (`O'Neil` = `ONeil`, Hawaiian ʻokina included). */
const APOSTROPHE_RE = /['`´‘’ʻʼ]/gu;
const COMBINING_RE = /\p{M}/gu;
const PUNCT_RE = /\p{P}/gu;
const SPACE_RE = /\s+/gu;
const CLEAN_RE = /^[a-z0-9 ]*$/;

/**
 * DynastyProcess-style `merge_name`: NFKD + lowercase + strip combining marks, fold the few Latin
 * letters NFKD leaves alone, drop apostrophes and every other punctuation character (hyphens and
 * periods included, so `Smith-Njigba` → `smithnjigba`, `St. Brown` → `st brown`), collapse
 * whitespace, strip trailing generational suffixes while more than two tokens remain. Returns null
 * for anything that is not a plain Latin-script name (homoglyphs, invisible characters, symbols,
 * control characters, empty, or longer than MAX_NAME_CHARS). Idempotent on its own output.
 */
export function mergeName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NAME_CHARS) return null;
  const folded = raw
    .replace(APOSTROPHE_RE, "")
    .normalize("NFKD")
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_RE, "")
    .replace(APOSTROPHE_RE, "")
    .replace(PUNCT_RE, "")
    .replace(SPACE_RE, " ")
    .trim();
  const ascii = FOLDS.reduce((acc, [from, to]) => acc.replaceAll(from, to), folded);
  if (!CLEAN_RE.test(ascii)) return null;
  const tokens = ascii.split(" ").filter((t) => t.length > 0);
  while (tokens.length > 2 && NAME_SUFFIXES.includes(String(tokens[tokens.length - 1])))
    tokens.pop();
  return tokens.length === 0 ? null : tokens.join(" ");
}

/**
 * The matcher's comparison key: `mergeName` with the spaces removed, so `D.J. Moore`, `DJ Moore`
 * and `Jaxon Smith Njigba` / `Smith-Njigba` compare equal. Null when `mergeName` is null.
 */
export function nameKey(raw: unknown): string | null {
  const merged = mergeName(raw);
  return merged === null ? null : merged.replaceAll(" ", "");
}

const NULLISH_ID_RE = /^(?:na|n\/a|null|none|nan|undefined|-)$/i;

/**
 * A third-party id cleaned to a usable string or null: trims (Sleeper's leading-space gsis ids),
 * maps empty and the `NA`-style placeholders (DynastyProcess writes the literal `NA`) to null,
 * rejects non-strings, over-long values and values with inner whitespace or control characters.
 */
export function cleanId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_ID_CHARS) return null;
  const id = raw.trim();
  if (id.length === 0 || NULLISH_ID_RE.test(id)) return null;
  return /[\s\u0000-\u001F\u007F]/u.test(id) ? null : id;
}

/** A gsis id cleaned by `cleanId` and checked against GSIS_ID_RE, else null. */
export function cleanGsisId(raw: unknown): string | null {
  const id = cleanId(raw);
  return id !== null && GSIS_ID_RE.test(id) ? id : null;
}
