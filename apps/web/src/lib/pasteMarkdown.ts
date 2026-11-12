// ---------------------------------------------------------------------------
// Pasting formatted text (Phase 54): a doc, an email, a chat answer or a web
// page puts HTML on the clipboard next to its plain text, and the plain text
// loses the bold, the list numbers and the code. This turns that HTML into
// the markdown our messages render (**bold**, _italic_, `code`, ```blocks```)
// plus readable lists ("1. …", "- …") and headings (bold lines), so what you
// paste looks like what you copied.
// ---------------------------------------------------------------------------

const BLOCKS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "BLOCKQUOTE",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "HR",
]);
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "META", "TITLE", "NOSCRIPT", "TEMPLATE"]);

/** Whether the clipboard's HTML is worth converting: formatting a plain paste would lose. */
export function hasRichFormatting(html: string): boolean {
  // Code editors (VS Code and friends) copy monospace HTML with `white-space: pre`:
  // their plain text is already right.
  if (/white-space:\s*pre/i.test(html)) return false;
  return /<(strong|b|em|i|code|pre|li|h[1-6]|kbd|samp|table)[\s>]|font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i.test(
    html,
  );
}

interface Marks {
  bold: boolean;
  italic: boolean;
  code: boolean;
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  return (el as HTMLElement).style ?? null;
}

function isBold(el: Element, inherited: boolean): boolean {
  const weight = styleOf(el)?.fontWeight ?? "";
  // Google Docs wraps the whole paste in <b style="font-weight:normal">.
  if (weight === "normal" || weight === "400" || weight === "lighter") return false;
  if (el.tagName === "B" || el.tagName === "STRONG") return true;
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) return true;
  return inherited;
}

function isItalic(el: Element, inherited: boolean): boolean {
  const style = styleOf(el)?.fontStyle ?? "";
  if (style === "normal") return false;
  if (el.tagName === "EM" || el.tagName === "I" || style === "italic") return true;
  return inherited;
}

function isCode(el: Element, inherited: boolean): boolean {
  if (["CODE", "KBD", "SAMP", "TT"].includes(el.tagName)) return true;
  return (
    inherited || /monospace|courier|menlo|consolas|monaco/i.test(styleOf(el)?.fontFamily ?? "")
  );
}

/** Wraps `text` in a marker, keeping its outer spaces outside (`** x**` doesn't render). */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before = "", core = "", after = ""] = match ?? [];
  return core ? `${before}${marker}${core}${marker}${after}` : text;
}

/** One list level being written: its kind and the next number. */
interface ListLevel {
  ordered: boolean;
  next: number;
}

/**
 * The markdown for `html` (what a rich paste carries). Plain text comes out
 * as it was; whitespace collapses as the browser would show it; blank lines
 * collapse to one.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  const lists: ListLevel[] = [];

  /** Starts a new line unless we're at one (or at the very start). */
  const newline = () => {
    const last = out.at(-1);
    if (last !== undefined && !last.endsWith("\n")) out.push("\n");
  };
  /** A blank line before a heading or after a block that wants air. */
  const blankLine = () => {
    newline();
    const text = out.join("");
    if (text && !text.endsWith("\n\n")) out.push("\n");
  };

  const inline = (node: Node, marks: Marks): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? "").replace(/\s+/g, " "); // `\s` covers no-break spaces too
    }
    if (!(node instanceof Element) || SKIP.has(node.tagName)) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return "";
    const next: Marks = {
      bold: isBold(node, marks.bold),
      italic: isItalic(node, marks.italic),
      code: isCode(node, marks.code),
    };
    let text = [...node.childNodes].map((child) => inline(child, next)).join("");
    // Cells of a table read through as text keep a space between them.
    if (node.tagName === "TD" || node.tagName === "TH") text = `${text} `;
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href) && text.trim() && text.trim() !== href) {
        // The same address written without its scheme ("example.com") is the link itself.
        const shown = text.trim();
        const bare = (url: string) =>
          url.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/\/$/, "");
        text = bare(href) === bare(shown) ? href : `${shown} (${href})`;
      } else if (/^https?:\/\//i.test(href) && !text.trim()) {
        text = href;
      }
    }
    // Marks open where they start, not again in every child.
    if (next.code && !marks.code) return text.includes("\n") ? text : wrap(text, "`");
    if (next.code) return text;
    if (next.bold && !marks.bold) text = wrap(text, "**");
    if (next.italic && !marks.italic) text = wrap(text, "_");
    return text;
  };

  /**
   * Inline content of a block, then its own line. `marks` are the block's own
   * (a bold paragraph): its lines are wrapped whole, inner marks aren't doubled.
   */
  const flushInline = (nodes: Node[], marks: Marks, prefix = "") => {
    const lines = nodes
      .map((n) => inline(n, marks))
      .join("")
      .split("\n")
      .map((line) => line.trim());
    const text = lines
      .map((line) => {
        if (!line) return line;
        let styled = line;
        if (marks.bold) styled = wrap(styled, "**");
        if (marks.italic) styled = wrap(styled, "_");
        return styled;
      })
      .join("\n")
      .trim();
    if (!text && !prefix) return;
    newline();
    out.push(prefix + text);
    newline();
  };
  const NONE: Marks = { bold: false, italic: false, code: false };
  /** An element's own marks on top of what it sits in. */
  const marksOf = (el: Element, marks: Marks): Marks => ({
    bold: isBold(el, marks.bold),
    italic: isItalic(el, marks.italic),
    code: false,
  });
  /** An inline element holding blocks (Docs wraps everything in a <b>): a container. */
  const holdsBlocks = (el: Element) =>
    !!el.querySelector("p,div,ul,ol,li,h1,h2,h3,h4,h5,h6,pre,table,blockquote,section,article");

  const block = (el: Element, marks: Marks) => {
    if (SKIP.has(el.tagName)) return;
    if (el.tagName === "PRE") {
      blankLine();
      out.push("```\n" + (el.textContent ?? "").replace(/\n+$/, "") + "\n```");
      blankLine();
      return;
    }
    if (el.tagName === "HR") {
      blankLine();
      return;
    }
    if (el.tagName === "UL" || el.tagName === "OL") {
      const start = Number(el.getAttribute("start") ?? "1");
      lists.push({ ordered: el.tagName === "OL", next: Number.isFinite(start) ? start : 1 });
      walk(el, marks);
      lists.pop();
      if (lists.length === 0) blankLine();
      return;
    }
    if (el.tagName === "LI") {
      const level = lists.at(-1) ?? { ordered: false, next: 1 };
      const indent = "  ".repeat(Math.max(0, lists.length - 1));
      const bullet = level.ordered ? `${level.next++}. ` : "- ";
      // The item's own text, then any nested blocks (sub-lists) after it.
      const own: Node[] = [];
      const nested: Element[] = [];
      for (const child of el.childNodes) {
        if (child instanceof Element && BLOCKS.has(child.tagName) && child.tagName !== "P")
          nested.push(child);
        else if (child instanceof Element && child.tagName === "P") own.push(...child.childNodes);
        else own.push(child);
      }
      const item = marksOf(el, marks);
      flushInline(own, item, indent + bullet);
      for (const child of nested) block(child, item);
      return;
    }
    if (el.tagName === "TABLE") {
      // A table of data becomes a markdown table (a message renders it as one).
      // One column, or cells that hold blocks, is a page's layout: read through.
      const rows = [...el.querySelectorAll("tr")]
        .filter((tr) => tr.closest("table") === el)
        .map((tr) =>
          [...tr.children]
            .filter((cell) => cell.tagName === "TD" || cell.tagName === "TH")
            .map((cell) => inline(cell, NONE).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
        )
        .filter((cells) => cells.some(Boolean));
      const columns = Math.max(0, ...rows.map((cells) => cells.length));
      const layout = !!el.querySelector("td p + p, td ul, td ol, td table, td h1, td h2, td h3");
      if (rows.length >= 2 && columns >= 2 && columns <= 12 && !layout) {
        const line = (cells: string[]) =>
          `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? "").join(" | ")} |`;
        blankLine();
        out.push(
          [
            line(rows[0]!),
            line(Array<string>(columns).fill("---")),
            ...rows.slice(1).map(line),
          ].join("\n"),
        );
        blankLine();
        return;
      }
    }
    if (HEADINGS.has(el.tagName)) {
      blankLine();
      const text = inline(el, { ...marks, bold: true }).trim();
      if (text) out.push(wrap(text, "**"));
      blankLine();
      return;
    }
    walk(el, marksOf(el, marks));
    if (el.tagName === "P" || el.tagName === "BLOCKQUOTE" || el.tagName === "TABLE") newline();
  };

  /** A container (`marks`: its own): runs of inline content become lines; blocks recurse. */
  function walk(parent: Element, marks: Marks) {
    let run: Node[] = [];
    const flush = () => {
      if (run.length) flushInline(run, marks);
      run = [];
    };
    for (const child of parent.childNodes) {
      if (child instanceof Element && BLOCKS.has(child.tagName)) {
        flush();
        block(child, marks);
      } else if (child instanceof Element && !SKIP.has(child.tagName) && holdsBlocks(child)) {
        flush();
        walk(child, marksOf(child, marks));
      } else {
        run.push(child);
      }
    }
    flush();
  }

  walk(doc.body, NONE);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
