import { describe, expect, it } from "vitest";
import { timeLogCsv, type TimeEntry } from "./timelog";

const entry = (patch: Partial<TimeEntry>): TimeEntry => ({
  entryId: "e",
  channelId: "c",
  userId: "u1",
  userName: "ana",
  date: "2026-11-10",
  minutes: 90,
  description: "Diseño",
  createdAt: 1,
  ...patch,
});

describe("timeLogCsv (Phase 70)", () => {
  it("lists the entries oldest first with hours and amounts, quoting and defusing formulas", () => {
    const csv = timeLogCsv(
      [
        entry({ date: "2026-11-11", description: 'API, "pagos"' }),
        entry({ userId: "u2", userName: "luis", description: "=HYPERLINK(x)" }),
      ],
      (e) => e.userName,
      { u1: 40 },
    );
    expect(csv.split("\n")).toEqual([
      "Fecha,Persona,Descripción,Horas,Tarifa (USD/h),Monto (USD)",
      "2026-11-10,luis,'=HYPERLINK(x),1.50,,",
      '2026-11-11,ana,"API, ""pagos""",1.50,40.00,60.00',
    ]);
  });
});
