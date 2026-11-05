import type { Attachment } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// Images in a task's description and notes (Phase 33). Task files live in a
// private bucket behind download links that expire within hours, so the text
// never holds a link. Tasks from Phase 33 refer to pasted images in their text
// as `![name](attachment:<key>)`; whoever shows the text signs a fresh link
// for that key, and only for files the task itself holds. Since then a pasted
// file only joins the task's attachments: the text stays text.
// ---------------------------------------------------------------------------

const SCHEME = "attachment:";
/** `![alt](attachment:<key>)`; alt has no `]` or line break, keys no `)` or spaces. */
const IMAGE_REF = /!\[([^\]\n]{0,200})\]\(attachment:([^)\s]{1,1024})\)/g;

/** Alt text can't close the brackets or break the line. */
const safeAlt = (name: string) => name.replace(/[[\]\n\r]/g, " ").slice(0, 200) || "image";

export const imageRef = (name: string, key: string) => `![${safeAlt(name)}](${SCHEME}${key})`;

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

/** The text without image references (or old upload placeholders), for a card's preview. */
export function textWithoutImages(text: string): string {
  return text
    .replace(IMAGE_REF, "")
    .replace(/!\[[^\]\n]*\]\(uploading:[^)\s]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Files pasted into a task's text (screenshots, copied files). Text that comes
 * with a picture of itself (a spreadsheet's cells, a selection in a document)
 * pastes as the text it is.
 */
export function pastedFiles(data: Pick<DataTransfer, "files" | "getData" | "types">): File[] {
  const files = [...data.files];
  if (files.length === 0) return [];
  const onlyImages = files.every((f) => f.type.startsWith("image/"));
  if (onlyImages && data.types.includes("text/plain") && data.getData("text/plain").trim()) {
    return [];
  }
  return files;
}

/** The task's images: those its text shows first (older tasks), then its other image files. */
export function taskImages(text: string, attachments: Attachment[]): Attachment[] {
  const referenced = referencedImages(text, attachments);
  const shown = new Set(referenced.map((a) => a.key));
  return [
    ...referenced,
    ...attachments.filter((a) => a.contentType.startsWith("image/") && !shown.has(a.key)),
  ];
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
