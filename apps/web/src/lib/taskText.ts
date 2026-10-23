import type { Attachment } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// Images in a task's description and notes (Phase 33). Task files live in a
// private bucket behind download links that expire within hours, so the text
// never holds a link: a pasted image becomes a file of the task and the text
// refers to it as `![name](attachment:<key>)`. Whoever shows the text signs a
// fresh link for that key, and only for files the task itself holds.
// ---------------------------------------------------------------------------

const SCHEME = "attachment:";
/** `![alt](attachment:<key>)`; alt has no `]` or line break, keys no `)` or spaces. */
const IMAGE_REF = /!\[([^\]\n]{0,200})\]\(attachment:([^)\s]{1,1024})\)/g;
/** While its upload runs: `![Uploading name…](uploading:<id>)`. */
const placeholderRef = (id: string) =>
  new RegExp(String.raw`\n?!\[[^\]\n]*\]\(uploading:${id}\)\n?`);

/** Alt text can't close the brackets or break the line. */
const safeAlt = (name: string) => name.replace(/[[\]\n\r]/g, " ").slice(0, 200) || "image";

export const imageRef = (name: string, key: string) => `![${safeAlt(name)}](${SCHEME}${key})`;
export const placeholder = (id: string, name: string) =>
  `![Uploading ${safeAlt(name)}…](uploading:${id})`;

export type TaskTextPart =
  { kind: "text"; text: string } | { kind: "image"; alt: string; key: string };

/** The text in order, image references split out. */
export function parseTaskText(text: string): TaskTextPart[] {
  const parts: TaskTextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(IMAGE_REF)) {
    const index = match.index ?? 0;
    if (index > at) parts.push({ kind: "text", text: text.slice(at, index) });
    parts.push({ kind: "image", alt: match[1] ?? "", key: match[2] ?? "" });
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

/** The task's own files the text shows as images, in order, each once. */
export function referencedImages(text: string, attachments: Attachment[]): Attachment[] {
  const byKey = new Map(attachments.map((a) => [a.key, a]));
  const seen = new Set<string>();
  const images: Attachment[] = [];
  for (const part of parseTaskText(text)) {
    if (part.kind !== "image" || seen.has(part.key)) continue;
    const file = byKey.get(part.key);
    if (!file?.contentType.startsWith("image/")) continue;
    seen.add(part.key);
    images.push(file);
  }
  return images;
}

/** The text without image references (or upload placeholders), for a card's preview. */
export function textWithoutImages(text: string): string {
  return text
    .replace(IMAGE_REF, "")
    .replace(/!\[[^\]\n]*\]\(uploading:[^)\s]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Puts `insertion` in place of the selection `start`–`end`, on lines of its
 * own (an image never runs into the words around it). Returns the new text
 * and where the caret goes.
 */
export function insertBlock(
  text: string,
  start: number,
  end: number,
  insertion: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after && !after.startsWith("\n") ? "\n" : "";
  const block = `${lead}${insertion}${trail}`;
  return { text: before + block + after, caret: before.length + lead.length + insertion.length };
}

/** The upload placeholder `id` replaced by `replacement` (the image reference). */
export const fillPlaceholder = (text: string, id: string, replacement: string) =>
  text.replace(new RegExp(String.raw`!\[[^\]\n]*\]\(uploading:${id}\)`), replacement);

/** The upload placeholder `id` taken out (its upload failed), with the line it had. */
export function dropPlaceholder(text: string, id: string): string {
  return text.replace(placeholderRef(id), (found) =>
    found.startsWith("\n") && found.endsWith("\n") ? "\n" : "",
  );
}

/** Whether the text still waits for an upload. */
export const hasPlaceholders = (text: string) => /\]\(uploading:[^)\s]+\)/.test(text);

/** What a paste carries that should become task images; none when it's text (a spreadsheet's cells come with a picture of them too). */
export function pastedImages(data: Pick<DataTransfer, "files" | "getData" | "types">): File[] {
  const images = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return [];
  if (data.types.includes("text/plain") && data.getData("text/plain").trim()) return [];
  return images;
}

/** Screenshots arrive as "image.png": give each paste a name worth reading in the file list. */
export function pastedName(file: File, now = new Date()): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const ext =
    file.type
      .split("/")[1]
      ?.replace("jpeg", "jpg")
      .replace(/[^a-z0-9]/gi, "") || "png";
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `pasted-${stamp}.${ext}`;
}
