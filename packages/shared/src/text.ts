// ---------------------------------------------------------------------------
// Text scanning in linear time (Phase 69). Some patterns used across the app
// backtrack quadratically on long input when written as one regex (Sonar
// S8786): a run of `[` with no `]`, or a heading line of thousands of spaces.
// These helpers give the same result as the regex each one documents, in one
// pass.
// ---------------------------------------------------------------------------

/**
 * A plausible email address: something, `@`, then a domain with a dot that is
 * neither its first nor its last character; no spaces, a single `@`. Same
 * strings as `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, without its backtracking.
 */
export const PLAUSIBLE_EMAIL = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/;

/** Characters `.` doesn't match in a regex without the `s` flag. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * An ATX heading's `#`s and text, or `null`: what
 * `/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/` captures (closing `#`s and spaces go).
 */
export function atxHeading(line: string): [hashes: string, text: string] | null {
  const open = /^\s{0,3}(#{1,6})\s+/.exec(line);
  if (!open) return null;
  let end = line.length;
  while (end > open[0].length && isSpace(line[end - 1])) end--;
  while (end > open[0].length && line[end - 1] === "#") end--;
  while (end > open[0].length && isSpace(line[end - 1])) end--;
  const text = line.slice(open[0].length, end);
  return LINE_TERMINATOR.test(text) ? null : [open[1]!, text];
}

/**
 * `text` with each markdown link `[label](url)` replaced by its label: what
 * `text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")` returns, or with
 * `emptyUrl`, `/\[([^\]]+)\]\([^)]*\)/g` (a link to nowhere: `[label]()`).
 */
export function unlinkMarkdown(text: string, { emptyUrl = false } = {}): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("[", from);
    if (open < 0) break;
    const close = text.indexOf("]", open + 1);
    if (close < 0) break;
    if (close === open + 1) {
      // `[]`: no label. The next `[` can only be past this `]`.
      from = close;
      continue;
    }
    const paren = close + 1;
    const end = text[paren] === "(" ? text.indexOf(")", paren + 1) : -1;
    if (text[paren] === "(" && end < 0) break; // no `)` left: no link further on either
    if (end > paren + (emptyUrl ? 0 : 1)) {
      out += text.slice(copied, open) + text.slice(open + 1, close);
      copied = from = end + 1;
    } else {
      // Every `[` before this `]` shares it, and fails the same way.
      from = close + 1;
    }
  }
  return out + text.slice(copied);
}

/**
 * `text` with each HTML tag replaced by `by`: what
 * `text.replace(/<[^>]+>/g, by)` returns, or with `empty`, `/<[^>]*>/g`
 * (`<>` counts as a tag too).
 */
export function replaceTags(text: string, by: string, { empty = false } = {}): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open < 0) break;
    const close = text.indexOf(">", open + 1);
    if (close < 0) break;
    if (close === open + 1 && !empty) {
      from = close;
      continue;
    }
    out += text.slice(copied, open) + by;
    copied = from = close + 1;
  }
  return out + text.slice(copied);
}
