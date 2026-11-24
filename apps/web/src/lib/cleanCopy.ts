// ---------------------------------------------------------------------------
// Copying from the app (Phase 82). A browser puts the selection on the
// clipboard with the page's look baked in: the dark theme's light text, the
// bubble's background, the code chip's grey. Pasted into a mail, a doc or
// another chat, that showed as grey boxes. Here the copy carries the words
// and their structure (paragraphs, lists, bold, links, code) and nothing of
// how they looked: no colours, no backgrounds, no fonts.
// ---------------------------------------------------------------------------

const BLOCKS = new Set([
  "P",
  "DIV",
  "LI",
  "UL",
  "OL",
  "PRE",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "TABLE",
  "SECTION",
  "ARTICLE",
]);
/** What a pasted copy may keep of an element: where a link goes. */
const KEPT_ATTRIBUTES = new Set(["href", "colspan", "rowspan", "start"]);
/** Never part of a copy: buttons, pictures of people, things read only by assistive tech. */
const DROPPED =
  "button, svg, img, video, audio, iframe, input, textarea, select, [aria-hidden='true'], .sr-only";

/** The selection without the app's look: structure and words only. */
export function cleanFragment(fragment: DocumentFragment | HTMLElement): HTMLElement {
  const root = document.createElement("div");
  root.append(fragment.cloneNode(true));
  for (const el of root.querySelectorAll(DROPPED)) el.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEPT_ATTRIBUTES.has(attr.name)) el.removeAttribute(attr.name);
    }
  }
  return root;
}

/** The fragment as plain text: a line per block, list items with their bullet or number. */
export function plainTextOf(root: HTMLElement): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/[ \t]+/g, " ").trim());
    line = "";
  };
  const walk = (node: Node, prefix = "") => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      flush();
      return;
    }
    const block = BLOCKS.has(node.tagName);
    if (block) flush();
    if (node.tagName === "PRE") {
      // Code keeps its own lines and spaces.
      lines.push(...(node.textContent ?? "").replace(/\n$/, "").split("\n"));
      return;
    }
    if (prefix) line += prefix;
    let n = Number(node.getAttribute("start")) || 1;
    for (const child of node.childNodes) {
      const item = child instanceof HTMLElement && child.tagName === "LI";
      walk(child, item ? (node.tagName === "OL" ? `${n++}. ` : "• ") : "");
    }
    if (block) flush();
  };
  walk(root);
  return lines.join("\n");
}

/**
 * From now on, a copy made anywhere in the app (outside a text field, which
 * copies its own text as always) puts clean text and clean HTML on the
 * clipboard. Returns how to undo it.
 */
export function installCleanCopy(): () => void {
  const onCopy = (event: ClipboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < selection.rangeCount; i++) {
      fragment.append(selection.getRangeAt(i).cloneContents());
    }
    const clean = cleanFragment(fragment);
    const text = plainTextOf(clean);
    if (!text) return;
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", clean.innerHTML);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}
