import sanitizeHtml from "sanitize-html";

/**
 * What a canvas may contain: exactly the HTML the web editor (TipTap) emits
 * for its blocks and marks. Anything else (scripts, styles, event handlers,
 * images, iframes, unknown tags) is dropped, keeping its text; links only
 * point at http(s) or mail addresses. The client never sets this HTML raw
 * either (the editor parses it into its schema), so this is defence in
 * depth for every reader, including ones that aren't the editor.
 */
const RULES: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "b",
    "em",
    "i",
    "s",
    "u",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "hr",
    "a",
    "label",
    "input",
    "div",
    "span",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    code: ["class"],
    ul: ["data-type"],
    li: ["data-type", "data-checked"],
    input: ["type", "checked"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  // Only checkboxes (task items); `type` is checked below.
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
    }),
  },
};

/** The canvas HTML as it may be stored and served. */
export function sanitizeCanvas(html: string): string {
  return sanitizeHtml(html, RULES);
}

/** Bytes of UTF-8 (what DynamoDB counts). */
export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
