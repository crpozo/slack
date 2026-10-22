import { z } from "zod";
import { dateInZone } from "./calendar";
import { transcriptClock } from "./callNotes";
import { UserIdSchema, type Message } from "./protocol";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH } from "./tasks";

// ---------------------------------------------------------------------------
// AI notes → board (Phase 29). The worker asks for "a bulleted list of
// Action Items" and writes in the participants' language, so the section is
// headed "Action Items", "Next steps", "Tareas", "Próximos pasos"… in any of
// the forms models use (`##`, `**bold**`, `Label:`). `extractActionItems`
// finds those sections and turns their top-level bullets into task drafts;
// the person reviews them before anything reaches a board.
// ---------------------------------------------------------------------------

/** At most this many tasks per send (one DynamoDB transaction with the card's claim). */
export const MAX_TASKS_FROM_NOTES = 25;

/** One action item as written by the model. */
export interface ActionItem {
  /** The item's text, markdown removed. */
  title: string;
  /** Nested bullets and wrapped lines under it, markdown removed. */
  details: string[];
  /**
   * Who it may be for, most likely reading first: `**Ana**: …`, `Ana: …`,
   * `… (Ana)`, `… — Ana`, or a person heading above it. Only hints until
   * `resolveOwner` matches one to a board member; `rest` is the title
   * without the name.
   */
  owners: OwnerHint[];
}

export interface OwnerHint {
  name: string;
  rest: string;
}

/** Lowercase, no accents, no emoji or punctuation, single spaces. */
export function normalizeLabel(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Headings that open an action-item section (normalized; a heading may also start with one). */
const ACTION_HEADINGS = [
  // English
  "action items",
  "action item",
  "action points",
  "actions",
  "next steps",
  "next actions",
  "to do",
  "to dos",
  "todo",
  "todos",
  "tasks",
  "follow ups",
  "follow up",
  "follow up items",
  "assigned tasks",
  "deliverables",
  // Spanish
  "tareas",
  "tareas pendientes",
  "tareas asignadas",
  "acciones",
  "acciones a tomar",
  "acciones pendientes",
  "elementos de accion",
  "puntos de accion",
  "items de accion",
  "proximos pasos",
  "siguientes pasos",
  "pasos a seguir",
  "pendientes",
  "compromisos",
  "asignaciones",
  "seguimiento",
  "entregables",
];

/**
 * Headings of other sections. Inside an action-item section, a bold or
 * `Label:` line that isn't one of these is read as a person grouping their
 * items (`**Ana**`), not as the end of the section.
 */
const OTHER_HEADINGS = [
  "summary",
  "overview",
  "decisions",
  "key decisions",
  "key points",
  "highlights",
  "notes",
  "discussion",
  "topics",
  "open questions",
  "questions",
  "risks",
  "blockers",
  "next meeting",
  "participants",
  "attendees",
  "context",
  "conclusion",
  "conclusions",
  "resumen",
  "sumario",
  "decisiones",
  "acuerdos",
  "puntos clave",
  "notas",
  "discusion",
  "temas",
  "preguntas abiertas",
  "preguntas",
  "riesgos",
  "bloqueos",
  "proxima reunion",
  "participantes",
  "asistentes",
  "contexto",
  "conclusion",
  "conclusiones",
];

const startsWithAny = (label: string, list: string[]) =>
  list.some((h) => label === h || label.startsWith(`${h} `));

/** "2. Action Items", "✅ Tareas", "Action Items (this week)" → whether it opens a section. */
export function isActionHeading(text: string): boolean {
  return startsWithAny(normalizeLabel(text.replace(/^\s*\d{1,2}[.)]\s+/, "")), ACTION_HEADINGS);
}

const isOtherHeading = (text: string) =>
  startsWithAny(normalizeLabel(text.replace(/^\s*\d{1,2}[.)]\s+/, "")), OTHER_HEADINGS);

const FENCE = /^\s*(```|~~~)/;
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
/** A line that is only bold text: `**Action Items**`, `**Tareas:**`, `__Next steps__:`. */
const BOLD_LINE = /^\s{0,3}(\*\*|__)(.+?)\1\s*:?\s*$/;
/** A short label line: `Action items:`, `Próximos pasos:` (no list marker, nothing after the colon). */
const LABEL_LINE = /^\s{0,3}([^\s\-*+•#>`|][^:]{0,58}):\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+•●◦▪‣–]|\d{1,3}[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+/;

/** Markdown out of one line of text: links keep their label, emphasis and code marks go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A name: one to three words of letters (`Ana`, `María José`, `Carlos P.`). */
const NAME = String.raw`[\p{L}][\p{L}'.-]*(?:\s[\p{L}][\p{L}'.-]*){0,2}`;
const BOLD_OWNER = new RegExp(
  String.raw`^(?:\*\*|__)\s*@?(${NAME})\s*:?\s*(?:\*\*|__)\s*[:–—-]?\s+(.+)$`,
  "u",
);
const PLAIN_OWNER = new RegExp(String.raw`^@?(${NAME})\s*:\s+(.+)$`, "u");
const TRAILING_OWNER = new RegExp(
  String.raw`^(.+?)\s*[([]\s*(?:owner|assignee|assigned to|responsable|encargad[oa]|asignad[oa] a)?\s*:?\s*@?(${NAME})\s*[)\]]\s*\.?$`,
  "iu",
);
/** `task — Name` or `Name — task`: which side is the name is up to the board's members. */
const DASH = /^(.+?)\s+[–—]\s+(.+)$/u;
const ONLY_NAME = new RegExp(String.raw`^@?(${NAME})\.?$`, "u");

/** The owner hints of one item's raw markdown, most likely first. */
function ownersOf(raw: string): OwnerHint[] {
  const hints: OwnerHint[] = [];
  const add = (name: string | undefined, rest: string | undefined) => {
    const n = plainText(name ?? "").replace(/^@/, "");
    const r = plainText(rest ?? "");
    if (n && r) hints.push({ name: n, rest: r });
  };
  for (const [pattern, nameAt, restAt] of [
    [BOLD_OWNER, 1, 2],
    [PLAIN_OWNER, 1, 2],
    [TRAILING_OWNER, 2, 1],
  ] as const) {
    const m = pattern.exec(raw);
    if (m) add(m[nameAt], m[restAt]);
  }
  const dash = DASH.exec(raw);
  if (dash) {
    const [, left = "", right = ""] = dash;
    if (ONLY_NAME.test(plainText(right))) add(right, left);
    if (ONLY_NAME.test(plainText(left))) add(left, right);
  }
  return hints;
}

interface Heading {
  /** 1–6 for `#`; 7 for bold and label lines (below every `#` heading). */
  level: number;
  text: string;
}

function headingOf(line: string): Heading | null {
  const atx = ATX.exec(line);
  if (atx) return { level: atx[1]!.length, text: plainText(atx[2]!) };
  const bold = BOLD_LINE.exec(line);
  if (bold) return { level: 7, text: plainText(bold[2]!) };
  const label = LABEL_LINE.exec(line);
  if (label) return { level: 7, text: plainText(label[1]!) };
  return null;
}

/**
 * The action items of a notes summary: the top-level bullets of every
 * section headed like "Action Items" or "Tareas" (in `#`, bold or `Label:`
 * form). A section ends at a heading of its level or above, at another
 * known section (`**Decisions**`) or at a rule; deeper headings and short
 * bold labels inside it group items by person. Checked `[x]` items are done
 * and skipped. Nothing outside those sections is ever taken.
 */
export function extractActionItems(markdown: string): ActionItem[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items: ActionItem[] = [];
  let section: Heading | null = null;
  let group: string | null = null;
  let baseIndent: number | null = null;
  let current: ActionItem | null = null;
  let lastWasItem = false;
  let inFence = false;

  const pushItem = (raw: string) => {
    const box = CHECKBOX.exec(raw);
    if (box && box[1] !== " ") {
      current = null; // already done
      return;
    }
    const text = box ? raw.slice(box[0].length) : raw;
    const title = plainText(text);
    if (!title) {
      current = null;
      return;
    }
    const owners = ownersOf(text);
    if (group) owners.push({ name: group, rest: title });
    current = { title, details: [], owners };
    items.push(current);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      lastWasItem = false;
      continue;
    }

    if (RULE.test(line)) {
      section = null;
      current = null;
      continue;
    }
    const listItem = LIST_ITEM.exec(line);
    const heading = listItem ? null : headingOf(line);
    if (heading) {
      lastWasItem = false;
      current = null;
      if (isActionHeading(heading.text)) {
        section = heading;
        group = null;
        baseIndent = null;
        continue;
      }
      if (!section) continue;
      if (isOtherHeading(heading.text)) {
        section = null; // "## Decisions", "**Riesgos**"…
        continue;
      }
      const personLabel = normalizeLabel(heading.text).split(" ").length <= 3;
      const deeper = heading.level > section.level;
      if (deeper || (heading.level === 7 && section.level === 7 && personLabel)) {
        // `### Ana` or `**Ana**` inside the section: her items follow.
        group = personLabel ? heading.text.replace(/^@/, "") : null;
        baseIndent = null;
        continue;
      }
      section = null;
      continue;
    }
    if (!section) continue;

    if (listItem) {
      const indent = listItem[1]!.length;
      const body = listItem[2]!;
      if (baseIndent === null || indent <= baseIndent) {
        baseIndent = indent;
        pushItem(body);
      } else if (current) {
        const detail = plainText(body.replace(CHECKBOX, ""));
        if (detail) (current as ActionItem).details.push(detail);
      }
      lastWasItem = true;
      continue;
    }
    // A wrapped line of the item above (indented, or lazily right under it).
    if (current && (lastWasItem || /^\s/.test(line))) {
      const more = plainText(line);
      const item = current as ActionItem;
      if (item.details.length > 0) item.details[item.details.length - 1] += ` ${more}`;
      else {
        item.title = `${item.title} ${more}`;
        item.owners = item.owners.map((o) => ({ ...o, rest: `${o.rest} ${more}` }));
      }
      continue;
    }
    // Prose under the list ("Overall, a good call.") is not an action item.
    current = null;
  }

  // The same item twice (the model repeated it under two people) is one task.
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeLabel(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Someone an owner hint can name. */
export interface OwnerCandidate {
  userId: string;
  displayName?: string;
  email?: string;
}

/**
 * The board member an owner hint names, matched on the full name, the first
 * name or the email's local part (accents and case ignored); `null` unless
 * exactly one member matches.
 */
export function resolveOwner(name: string, candidates: OwnerCandidate[]): string | null {
  const wanted = normalizeLabel(name);
  if (!wanted) return null;
  const matches = candidates.filter((c) => {
    const full = normalizeLabel(c.displayName ?? "");
    const first = full.split(" ")[0] ?? "";
    const local = normalizeLabel((c.email ?? "").split("@")[0] ?? "");
    return wanted === full || wanted === first || wanted === local;
  });
  const ids = [...new Set(matches.map((c) => c.userId))];
  return ids.length === 1 ? ids[0]! : null;
}

/** Cuts at a word boundary with an ellipsis, so `text` fits in `max` characters. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What `POST /boards/{id}/tasks/from-notes` creates for one item. */
export interface TaskDraft {
  title: string;
  description: string;
  assigneeId: string | null;
}

/**
 * One item as a task: the first owner hint that names a single board member
 * becomes the assignee (and leaves the title); a title too long for a card
 * is clipped, the full text kept in the description with the details.
 */
export function taskDraftOf(item: ActionItem, members: OwnerCandidate[]): TaskDraft {
  let assigneeId: string | null = null;
  let full = item.title;
  for (const hint of item.owners) {
    assigneeId = resolveOwner(hint.name, members);
    if (assigneeId) {
      full = hint.rest;
      break;
    }
  }
  const title = clip(full, MAX_TASK_TITLE_LENGTH);
  // One line: task fields take no control characters, newlines included.
  const parts = [...(title === full ? [] : [full]), ...item.details];
  return {
    title,
    description: clip(parts.join(" · "), MAX_TASK_DESCRIPTION_LENGTH),
    assigneeId,
  };
}

/** Where a task came from (its `notes` field): "call with Ana on 2026-10-22 (12:34)". */
export function taskProvenance(peerName: string, startedAt: number, endedAt: number): string {
  return `From ✨ AI call notes: call with ${peerName} on ${dateInZone(endedAt)} (${transcriptClock(endedAt, startedAt)}).`;
}

/** The same rule as the Task Manager's own fields (`CreateTaskSchema`). */
const draftText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v), "cannot contain control characters");

/** `POST /boards/{boardId}/tasks/from-notes`: the reviewed drafts of one notes card. */
export const TasksFromNotesSchema = z.object({
  /** The notes card: its conversation and sort key. */
  channelId: z.string().min(1).max(256),
  sk: z.string().min(1).max(128),
  tasks: z
    .array(
      z.object({
        title: draftText(MAX_TASK_TITLE_LENGTH).pipe(z.string().min(1)),
        description: draftText(MAX_TASK_DESCRIPTION_LENGTH).default(""),
        assigneeId: UserIdSchema.nullable().default(null),
      }),
    )
    .min(1)
    .max(MAX_TASKS_FROM_NOTES),
});
export type TasksFromNotesInput = z.input<typeof TasksFromNotesSchema>;

// ---------------------------------------------------------------------------
// The AI Notes hub (Phase 29): `GET /notes` pages through every notes card
// of the conversations you're in, newest first, via the per-person index
// table (`meeting-notes`: userId + the message's sort key).
// ---------------------------------------------------------------------------

export const NOTES_PAGE_SIZE = 20;

/** One row of the `meeting-notes` index table: a pointer to a notes card. */
export interface MeetingNoteIndexItem {
  userId: string;
  /** The card's message sort key: time-ordered, so the index reads newest first. */
  sk: string;
  channelId: string;
  callId: string;
  endedAt: number;
}

export interface NotesPage {
  notes: Message[];
  /** Opaque; `null` on the last page. */
  nextCursor: string | null;
}
