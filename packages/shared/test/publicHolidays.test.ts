import { describe, expect, it } from "vitest";
import {
  easterSunday,
  ecuadorHolidayDates,
  ecuadorHolidays,
  publicHolidayCountry,
  publicHolidayEvent,
  publicHolidaysBetween,
  usHolidays,
} from "../src/publicHolidays";

// Phase 62: Ecuador's and the United States' holidays, computed.

const dates = (list: Array<{ date: string; name: string }>) =>
  Object.fromEntries(
    list.map((h) => [`${h.name}${h.name === "Carnaval" ? ` ${h.date}` : ""}`, h.date]),
  );

describe("public holidays", () => {
  it("finds Easter", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
  });

  it("Ecuador 2026: Carnival and Good Friday from Easter, the rest moved to a long weekend", () => {
    const ec = dates(ecuadorHolidays(2026));
    expect(ec).toMatchObject({
      "Año Nuevo": "2026-01-01",
      "Carnaval 2026-02-16": "2026-02-16",
      "Carnaval 2026-02-17": "2026-02-17",
      "Viernes Santo": "2026-04-03",
      "Día del Trabajo": "2026-05-01",
      // Sunday 24 May → Monday 25.
      "Batalla de Pichincha": "2026-05-25",
      // Monday 10 August: as it falls.
      "Primer Grito de Independencia": "2026-08-10",
      // Friday 9 October: as it falls.
      "Independencia de Guayaquil": "2026-10-09",
      // Monday and Tuesday: as they fall.
      "Día de los Difuntos": "2026-11-02",
      "Independencia de Cuenca": "2026-11-03",
      Navidad: "2026-12-25",
      // Loja's: Wednesday 18 November → Friday 20; Tuesday 8 December → Monday 7.
      "Independencia de Loja": "2026-11-20",
      "Fundación de Loja": "2026-12-07",
    });
  });

  it("Ecuador moves a midweek holiday, and keeps 2–3 November together", () => {
    const ec2027 = dates(ecuadorHolidays(2027));
    // Tuesday 10 August 2027 → Monday 9; Saturday 1 May → Friday 30 April.
    expect(ec2027["Primer Grito de Independencia"]).toBe("2027-08-09");
    expect(ec2027["Día del Trabajo"]).toBe("2027-04-30");
    // Tuesday and Wednesday → Monday and Tuesday.
    expect(ec2027["Día de los Difuntos"]).toBe("2027-11-01");
    expect(ec2027["Independencia de Cuenca"]).toBe("2027-11-02");
    // Saturday 25 December → Friday 24; 1 January 2028 (a Saturday) → Friday 31 December 2027.
    expect(ec2027.Navidad).toBe("2027-12-24");
    expect(ecuadorHolidayDates("2027-12-27", "2027-12-31")).toEqual(new Set(["2027-12-31"]));
  });

  it("United States 2026: the floating Mondays and Thanksgiving", () => {
    expect(dates(usHolidays(2026))).toMatchObject({
      "Martin Luther King Jr. Day": "2026-01-19",
      "Presidents' Day": "2026-02-16",
      "Memorial Day": "2026-05-25",
      "Independence Day": "2026-07-04",
      "Labor Day": "2026-09-07",
      "Columbus Day": "2026-10-12",
      "Veterans Day": "2026-11-11",
      Thanksgiving: "2026-11-26",
    });
  });

  it("lists both countries in a range, as calendar events nobody edits", () => {
    const november = publicHolidaysBetween("2026-11-01", "2026-11-30");
    expect(november.map((h) => `${h.country} ${h.date}`)).toEqual([
      "EC 2026-11-02",
      "EC 2026-11-03",
      "US 2026-11-11",
      "EC 2026-11-20",
      "US 2026-11-26",
    ]);
    const event = publicHolidayEvent(november[0]!);
    expect(event).toMatchObject({
      type: "holiday",
      title: "🇪🇨 Día de los Difuntos",
      startDate: "2026-11-02",
      endDate: "2026-11-02",
    });
    expect(publicHolidayCountry(event.eventId)).toBe("EC");
    expect(publicHolidayCountry(publicHolidayEvent(november[2]!).eventId)).toBe("US");
    expect(publicHolidayCountry("ev_123")).toBeNull();
  });
});
