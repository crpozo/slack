import { describe, expect, it } from "vitest";
import {
  clip,
  extractActionItems,
  isActionHeading,
  MAX_TASKS_FROM_NOTES,
  plainText,
  resolveOwner,
  taskDraftOf,
  taskProvenance,
  TasksFromNotesSchema,
} from "../src";

const titles = (md: string) => extractActionItems(md).map((i) => i.title);

describe("isActionHeading", () => {
  it.each([
    "Action Items",
    "ACTION ITEMS",
    "Action items (this week)",
    "2. Action Items",
    "✅ Next steps",
    "To-Do",
    "Follow-ups",
    "Tareas",
    "Tareas pendientes",
    "Próximos pasos",
    "PRÓXIMOS PASOS",
    "Siguientes pasos",
    "Acciones a tomar",
    "Elementos de acción",
    "Puntos de acción",
    "Compromisos",
    "📌 Pendientes",
  ])("recognizes %s", (heading) => expect(isActionHeading(heading)).toBe(true));

  it.each(["Summary", "Resumen", "Decisiones", "Key points", "Taskforce update", "Acuerdos"])(
    "ignores %s",
    (heading) => expect(isActionHeading(heading)).toBe(false),
  );
});

describe("extractActionItems", () => {
  it("takes the bullets under '## Action Items' and nothing from the summary", () => {
    const md = [
      "## Summary",
      "",
      "Carlos and Ana agreed on the plan.",
      "- this bullet is context, not a task",
      "",
      "## Action Items",
      "",
      "- **Carlos**: send the release notes by Thursday",
      "- Ana: review the hosting budget",
      "  - check the *CloudFront* line",
      "  - confirm with finance",
      "- Book the demo room",
      "",
      "Overall a productive call.",
    ].join("\n");
    const items = extractActionItems(md);
    expect(items.map((i) => i.title)).toEqual([
      "Carlos: send the release notes by Thursday",
      "Ana: review the hosting budget",
      "Book the demo room",
    ]);
    expect(items[0]!.owners).toEqual([
      { name: "Carlos", rest: "send the release notes by Thursday" },
    ]);
    expect(items[1]!.details).toEqual(["check the CloudFront line", "confirm with finance"]);
    expect(items[2]!.owners).toEqual([]);
  });

  it("reads Spanish sections in every heading style", () => {
    const atx =
      "## Resumen\n\nTodo bien.\n\n### Próximos pasos\n\n1. Enviar la propuesta\n2. Revisar el presupuesto";
    expect(titles(atx)).toEqual(["Enviar la propuesta", "Revisar el presupuesto"]);
    const bold =
      "**Resumen:** todo bien.\n\n**Tareas:**\n* Llamar al proveedor\n* Actualizar el tablero";
    expect(titles(bold)).toEqual(["Llamar al proveedor", "Actualizar el tablero"]);
    const label = "Acciones a tomar:\n• Preparar la demo\n• Enviar el acta";
    expect(titles(label)).toEqual(["Preparar la demo", "Enviar el acta"]);
    const accents = "# ELEMENTOS DE ACCIÓN\n- Confirmar fecha";
    expect(titles(accents)).toEqual(["Confirmar fecha"]);
  });

  it("ends the section at a same-level heading, another known section or a rule", () => {
    expect(titles("## Tareas\n- uno\n## Decisiones\n- no es tarea")).toEqual(["uno"]);
    expect(titles("**Action Items**\n- one\n**Decisions**\n- not a task")).toEqual(["one"]);
    expect(titles("Next steps:\n- one\n---\n- not a task")).toEqual(["one"]);
    expect(titles("## Action Items\n- one\n### Risks\n- not a task")).toEqual(["one"]);
  });

  it("groups by person under deeper headings or short bold labels", () => {
    const md = [
      "## Action Items",
      "### Ana",
      "- Review the budget",
      "### Carlos",
      "- Send the notes",
      "**María José**",
      "- Book the room",
    ].join("\n");
    const items = extractActionItems(md);
    expect(items.map((i) => [i.owners[0]?.name, i.title])).toEqual([
      ["Ana", "Review the budget"],
      ["Carlos", "Send the notes"],
      ["María José", "Book the room"],
    ]);
  });

  it("finds owners written after the task, and reads a dash both ways", () => {
    const items = extractActionItems(
      "## Tareas\n- Enviar la propuesta (Responsable: Ana)\n- Fix the build — Carlos\n- Ship it [@Ana]\n- Ana — call the bank",
    );
    expect(items.map((i) => i.owners)).toEqual([
      [{ name: "Ana", rest: "Enviar la propuesta" }],
      [
        { name: "Carlos", rest: "Fix the build" },
        { name: "Fix the build", rest: "Carlos" },
      ],
      [{ name: "Ana", rest: "Ship it" }],
      [
        { name: "call the bank", rest: "Ana" },
        { name: "Ana", rest: "call the bank" },
      ],
    ]);
    const members = [
      { userId: "u-ana", displayName: "Ana" },
      { userId: "u-c", displayName: "Carlos" },
    ];
    expect(items.map((i) => taskDraftOf(i, members))).toMatchObject([
      { title: "Enviar la propuesta", assigneeId: "u-ana" },
      { title: "Fix the build", assigneeId: "u-c" },
      { title: "Ship it", assigneeId: "u-ana" },
      { title: "call the bank", assigneeId: "u-ana" },
    ]);
  });

  it("skips done checkboxes, strips open ones and joins wrapped lines", () => {
    const md = "## To-do\n- [x] already done\n- [ ] still open\n- a long item that\n  wraps here";
    expect(titles(md)).toEqual(["still open", "a long item that wraps here"]);
  });

  it("collects every action section, drops repeats and ignores code fences", () => {
    const md = [
      "## Action Items",
      "- One",
      "```",
      "- not markdown",
      "```",
      "## Notes",
      "- note",
      "## Next steps",
      "- one",
      "- Two",
    ].join("\n");
    expect(titles(md)).toEqual(["One", "Two"]);
  });

  it("finds nothing when there is no action section", () => {
    expect(extractActionItems("## Summary\n\n- a\n- b")).toEqual([]);
    expect(extractActionItems("")).toEqual([]);
  });

  it("leaves markdown and HTML out of the titles", () => {
    expect(titles("## Tasks\n- See [the spec](https://x.ec) and `deploy.sh` <b>now</b>")).toEqual([
      "See the spec and deploy.sh now",
    ]);
    expect(plainText("**bold** _it_ *em* snake_case_name ~~old~~")).toBe(
      "bold it em snake_case_name old",
    );
  });
});

describe("turning items into task drafts", () => {
  const members = [
    { userId: "u-carlos", displayName: "Carlos Pozo", email: "carlos@mindfultech.ec" },
    { userId: "u-ana", displayName: "Ana María Ruiz", email: "aruiz@mindfultech.ec" },
    { userId: "u-ana2", displayName: "Ana Vega", email: "avega@mindfultech.ec" },
  ];

  it("resolves an owner only on a single match (full name, first name or email)", () => {
    expect(resolveOwner("Carlos", members)).toBe("u-carlos");
    expect(resolveOwner("carlos pozo", members)).toBe("u-carlos");
    expect(resolveOwner("aruiz", members)).toBe("u-ana");
    expect(resolveOwner("Ana", members)).toBeNull(); // two Anas
    expect(resolveOwner("Ana María Ruiz", members)).toBe("u-ana");
    expect(resolveOwner("Pedro", members)).toBeNull();
  });

  it("assigns and drops the name from the title only when the owner resolves", () => {
    const [carlos, both] = extractActionItems(
      "## Action Items\n- **Carlos**: send the notes\n  - by Friday\n- Both: demo",
    );
    expect(taskDraftOf(carlos!, members)).toEqual({
      title: "send the notes",
      description: "by Friday",
      assigneeId: "u-carlos",
    });
    expect(taskDraftOf(both!, members)).toEqual({
      title: "Both: demo",
      description: "",
      assigneeId: null,
    });
  });

  it("clips long titles at a word and keeps the full text in the description", () => {
    const long = `Prepare ${"the quarterly report ".repeat(20)}`.trim();
    const draft = taskDraftOf({ title: long, details: [], owners: [] }, members);
    expect(draft.title.length).toBeLessThanOrEqual(200);
    expect(draft.title.endsWith("…")).toBe(true);
    expect(draft.description).toBe(long);
    expect(clip("short", 10)).toBe("short");
  });

  it("validates a send: 1 to 25 tasks, no control characters", () => {
    const task = { title: "Do it" };
    expect(
      TasksFromNotesSchema.safeParse({ channelId: "dm_a_b", sk: "1#x", tasks: [task] }).success,
    ).toBe(true);
    expect(
      TasksFromNotesSchema.safeParse({ channelId: "dm_a_b", sk: "1#x", tasks: [] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_TASKS_FROM_NOTES + 1 }, () => task);
    expect(
      TasksFromNotesSchema.safeParse({ channelId: "dm_a_b", sk: "1#x", tasks: many }).success,
    ).toBe(false);
    expect(
      TasksFromNotesSchema.safeParse({
        channelId: "dm_a_b",
        sk: "1#x",
        tasks: [{ title: "a\u0007b" }],
      }).success,
    ).toBe(false);
  });
});

describe("taskProvenance", () => {
  it("names the other person, the company-time date and the length", () => {
    // 2026-10-23 03:00 UTC is still the 22nd in Guayaquil.
    const endedAt = Date.UTC(2026, 9, 23, 3, 0, 0);
    expect(taskProvenance("Ana", endedAt - 754_000, endedAt)).toBe(
      "From ✨ AI call notes: call with Ana on 2026-10-22 (12:34).",
    );
  });
});
