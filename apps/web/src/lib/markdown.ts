import { URL_PATTERN } from "@mindfultech/shared";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** http(s) links as messages show them (shared with the server's link index, Phase 38). */
export { URL_PATTERN };
/** `[label](https://…)` (after escaping), http(s) only: anything else stays text. */
const MD_LINK_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s<)]+)\)/g;
const MARKER = /\uE000(\d+)\uE000/g;

interface InlineOptions {
  /** `*italic*` and `[label](url)` too: what models write (AI call notes). */
  modelMarkdown?: boolean;
}

/** Stash for spans no later rule may touch; markers carry the index. */
function createStash() {
  const items: string[] = [];
  const keep = (html: string) => `\uE000${items.push(html) - 1}\uE000`;
  // A stashed span can hold an earlier one (a link label with code in it).
  const restore = (html: string): string =>
    html.replace(MARKER, (_, i: string) => restore(items[Number(i)] ?? ""));
  return { keep, restore };
}

/** Inline rules over already-escaped HTML: `code`, links, **bold**, _italic_. */
function formatInline(html: string, keep: (html: string) => string, options: InlineOptions = {}) {
  let out = html.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`));
  if (options.modelMarkdown) {
    out = out.replace(MD_LINK_PATTERN, (_, label: string, url: string) =>
      keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`),
    );
  }
  out = out.replace(URL_PATTERN, (url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`),
  );
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
  if (options.modelMarkdown) {
    // `*word*`, not `2 * 3 * 4`: no space just inside the stars.
    out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<em>$2</em>");
  }
  return out;
}

/**
 * Light markdown → HTML: ```blocks```, `code`, **bold**, _italic_, links and
 * line breaks. The input is HTML-escaped first, so the output is safe to
 * inject; code and links are stashed so other rules never touch them.
 */
export function renderMarkdown(text: string): string {
  const { keep, restore } = createStash();

  let html = escapeHtml(text.replaceAll("\uE000", ""));

  html = html.replace(/```(?:\n)?([\s\S]*?)```/g, (_, code: string) =>
    keep(`<pre><code>${code}</code></pre>`),
  );
  html = formatInline(html, keep);
  html = html.replaceAll("\n", "<br>");

  return restore(html);
}

// ---------------------------------------------------------------------------
// Block markdown for AI call notes (Phase 28). The model writes a summary
// paragraph and a bulleted list of action items, with whatever bullets it
// likes (`-`, `*`, `+`, `•`, `1.`), nesting by indentation, `[ ]` checkboxes,
// headings and `---` rules. Every bit of text still goes through
// `escapeHtml` before any tag is added, and the only tags are the ones built
// here, so a transcript that talked the model into writing HTML or
// `javascript:` links renders it as text.
// ---------------------------------------------------------------------------

/** Lists deeper than this flatten into the last level (nobody nests that far on purpose). */
export const MAX_LIST_DEPTH = 4;

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)(?:([-*+•●◦▪‣–])|(\d{1,9})[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

interface OpenList {
  indent: number;
  tag: "ul" | "ol";
}

export function renderNotesMarkdown(text: string): string {
  const { keep, restore } = createStash();
  const inline = (s: string) => formatInline(escapeHtml(s), keep, { modelMarkdown: true }).trim();

  const lines = text.replaceAll("\uE000", "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  const lists: OpenList[] = [];
  let blankInList = false;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
    quote = [];
  };
  const closeLists = (downTo = 0) => {
    while (lists.length > downTo) out.push(`</li></${lists.pop()!.tag}>`);
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    closeLists();
    blankInList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\t/g, "    ");

    if (FENCE.test(line)) {
      flushAll();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(keep(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushQuote();
      if (lists.length) blankInList = true;
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      // Inside a message the card title is the top heading: model `#`/`##` → h3, deeper → h4.
      const tag = heading[1]!.length <= 2 ? "h3" : "h4";
      out.push(`<${tag}>${inline(heading[2]!)}</${tag}>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      flushQuote();
      blankInList = false;
      const indent = item[1]!.length;
      const tag = item[3] === undefined ? "ul" : "ol";
      const top = lists.at(-1);
      if (!top || (indent > top.indent && lists.length < MAX_LIST_DEPTH)) {
        // A new list, nested inside the open item when there is one.
        const start = tag === "ol" && Number(item[3]) !== 1 ? ` start="${Number(item[3])}"` : "";
        out.push(`<${tag}${start}>`);
        lists.push({ indent, tag });
      } else {
        while (lists.length > 1 && indent < lists.at(-1)!.indent) {
          out.push(`</li></${lists.pop()!.tag}>`);
        }
        const current = lists.at(-1)!;
        if (current.tag !== tag) {
          // `-` items after `1.` items at the same depth: a new list of the other kind.
          out.push(`</li></${current.tag}><${tag}>`);
          current.tag = tag;
        } else {
          out.push("</li>");
        }
      }
      const task = TASK.exec(item[4]!);
      out.push(
        task
          ? `<li class="task"><span class="check" aria-label="${task[1] === " " ? "To do" : "Done"}">${
              task[1] === " " ? "☐" : "☑"
            }</span> ${inline(task[2]!)}`
          : `<li>${inline(item[4]!)}`,
      );
      continue;
    }
    if (lists.length && !blankInList) {
      // An item's wrapped line (indented or not, as markdown's lazy continuation allows).
      out.push(`<br>${inline(line)}`);
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      closeLists();
      blankInList = false;
      quote.push(inline(quoted[1]!));
      continue;
    }
    flushQuote();
    closeLists();
    blankInList = false;
    paragraph.push(inline(line));
  }
  flushAll();
  return restore(out.join(""));
}
