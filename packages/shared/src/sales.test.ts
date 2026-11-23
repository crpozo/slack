import { describe, expect, it } from "vitest";
import {
  callMetrics,
  canEditSales,
  coachingTrend,
  companyKey,
  duplicateOf,
  findQuotes,
  forecastOf,
  isVerbatim,
  oppGaps,
  roiDeck,
  roiModel,
  salesCsv,
  salesDiff,
  salesPriorities,
  SalesRecordSchema,
  transcriptLines,
  visibleSales,
  type SalesAccount,
  type SalesCall,
  type SalesOpportunity,
  type SalesRecord,
} from "./sales";
import { DEMO_ACCOUNT_ID, DEMO_OPP_ID, DEMO_ROI, demoSalesSeed } from "./salesDemo";

const NOW = Date.UTC(2026, 10, 20, 15);
const seed = demoSalesSeed(NOW);
const opps = seed.records.filter((r): r is SalesOpportunity => r.kind === "opportunity");

describe("the demo's data", () => {
  it("is valid, marked fictitious and tied to one account and opportunity", () => {
    for (const r of seed.records) {
      expect(SalesRecordSchema.safeParse(r).success, r.id).toBe(true);
      expect(r.demo).toBe(true);
      expect(r.id.startsWith("demo_")).toBe(true);
    }
    for (const a of seed.artifacts) {
      expect(a.accountId).toBe(DEMO_ACCOUNT_ID);
      expect(a.opportunityId).toBe(DEMO_OPP_ID);
    }
    // Every quote of the prepared results is in its source, word for word.
    const text = (id: string) => {
      const r = seed.records.find((x) => x.id === id);
      return r?.kind === "meeting" ? r.notes : "";
    };
    for (const a of seed.artifacts)
      for (const s of a.result.sections)
        for (const i of s.items)
          if (i.kind === "cita")
            expect(isVerbatim(text(i.sources[0]!), i.quote), i.quote).toBe(true);
  });
});

describe("ROI, computed in code", () => {
  it("adds benefits with a ramp, costs, net, ROI and payback", () => {
    const m = roiModel({
      currency: "USD",
      horizonMonths: 12,
      investment: 12_000,
      recurringMonthly: 500,
      currentMonthlyCost: 0,
      benefits: [
        { name: "a", monthly: 2_000 },
        { name: "b", monthly: 1_000 },
      ],
      rampMonths: 2,
      scenarios: { conservador: 0.5, base: 1, optimista: 1.5 },
    });
    const b = m.scenarios.base;
    // Month 1 at half (1,500), then 11 months at 3,000.
    expect(b.totalBenefit).toBe(34_500);
    expect(b.totalCost).toBe(18_000);
    expect(b.net).toBe(16_500);
    expect(b.roiPct).toBe(91.7);
    // -12,000 +1,000 (m1) then +2,500 a month: zero or more at month 6.
    expect(b.cumulative[1]).toBe(-11_000);
    expect(b.paybackMonth).toBe(6);
    expect(b.cumulative[12]).toBe(b.net);
    expect(m.scenarios.conservador.paybackMonth).toBeNull();
    expect(m.scenarios.optimista.net).toBeGreaterThan(b.net);
  });

  it("the decision deck has 8 to 12 slides and repeats the model's figures", () => {
    const m = roiModel(DEMO_ROI);
    const deck = roiDeck({ name: "Acme" }, { name: "Opp", nextStep: "", criteria: "" }, m);
    expect(deck.length).toBeGreaterThanOrEqual(8);
    expect(deck.length).toBeLessThanOrEqual(12);
    const all = JSON.stringify(deck);
    const n = (x: number) => new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 }).format(x);
    expect(all).toContain(n(m.scenarios.base.net));
    expect(all).toContain(`${m.scenarios.base.roiPct}%`);
    expect(all).toContain(`mes ${m.scenarios.base.paybackMonth}`);
  });
});

describe("the forecast", () => {
  it("totals by currency and category, each opportunity once, traceable to its ids", () => {
    const eur = {
      ...opps[0]!,
      id: "x_eur",
      currency: "EUR",
      amount: 10,
      forecastCategory: "commit" as const,
    };
    const won = { ...opps[0]!, id: "x_won", stage: "cerrada_ganada" as const, amount: 5 };
    const lost = { ...opps[0]!, id: "x_lost", stage: "cerrada_perdida" as const, amount: 999 };
    const totals = forecastOf([...opps, ...opps, eur, won, lost]);
    const usd = totals.find((t) => t.currency === "USD")!;
    expect(usd.commit.amount).toBe(84_000 + 36_000);
    expect(usd.commit.ids.sort()).toEqual(["demo_opp_andina", "demo_opp_litoral"]);
    expect(usd.best_case.amount).toBe(52_000);
    expect(usd.won).toEqual({ amount: 5, ids: ["x_won"] });
    expect(totals.find((t) => t.currency === "EUR")!.commit.amount).toBe(10);
    expect(JSON.stringify(totals)).not.toContain("x_lost");
    const sum = (ids: string[]) =>
      ids.reduce((n, id) => n + [...opps, eur, won].find((o) => o.id === id)!.amount, 0);
    expect(sum(usd.commit.ids)).toBe(usd.commit.amount);
  });

  it("filters by owner and period", () => {
    expect(forecastOf(opps, { ownerId: "someone-else" })).toEqual([]);
    const soon = forecastOf(opps, { to: opps.find((o) => o.id === DEMO_OPP_ID)!.closeDate });
    expect(soon[0]!.commit.ids).toEqual([DEMO_OPP_ID]);
  });

  it("flags the demo opportunity: committed without next step, decision-maker or recent meeting", () => {
    const gaps = oppGaps(
      opps.find((o) => o.id === DEMO_OPP_ID)!,
      seed.records,
      NOW,
    ).map((g) => g.text);
    expect(gaps).toEqual(
      expect.arrayContaining([
        "Sin próximo paso acordado",
        "No hay un decisor identificado en la cuenta",
        "Comprometida sin proceso de decisión documentado",
      ]),
    );
    expect(gaps.some((g) => g.startsWith("Sin reuniones desde hace"))).toBe(true);
    const first = salesPriorities(seed.records, seed.changes, null, NOW)[0]!;
    expect(first.accountId).toBe(DEMO_ACCOUNT_ID);
    expect(first.reasons.every((r) => seed.records.some((x) => x.id === r.recordId))).toBe(true);
  });
});

describe("permissions", () => {
  const real = (r: SalesRecord, patch: object): SalesRecord =>
    ({ ...r, demo: undefined, ...patch }) as SalesRecord;
  const acct = seed.records[0] as SalesAccount;
  const mine = real(acct, { id: "a_mine", ownerId: "u1" });
  const theirs = real(acct, { id: "a_theirs", ownerId: "u2" });
  const theirOpp = real(opps[0]!, { id: "o_theirs", ownerId: "u2", accountId: "a_theirs" });
  const sharedOpp = real(opps[0]!, { id: "o_on_mine", ownerId: "u2", accountId: "a_mine" });
  const call = seed.records.find((r): r is SalesCall => r.kind === "call")!;
  const privateCall = real(call, {
    id: "c_private",
    ownerId: "u2",
    shareable: false,
    accountId: "",
  });
  const sharedCall = real(call, { id: "c_shared", ownerId: "u2", shareable: true, accountId: "" });
  const doc = real(
    seed.records.find((r) => r.kind === "doc")!,
    { id: "d1", ownerId: "u2" },
  );
  const all = [mine, theirs, theirOpp, sharedOpp, privateCall, sharedCall, doc];

  it("a rep sees their accounts and what hangs from them, shared knowledge, never a colleague's", () => {
    const ids = visibleSales(all, "u1", "member").map((r) => r.id);
    expect(ids.sort()).toEqual(["a_mine", "c_shared", "d1", "o_on_mine"]);
    expect(visibleSales(all, "u1", "admin")).toHaveLength(all.length);
    expect(visibleSales(all, "u1", "guest")).toEqual([]);
    expect(visibleSales(seed.records, "u1", "member")).toHaveLength(seed.records.length);
  });

  it("a rep edits their own and their accounts' records, not a colleague's call or document", () => {
    const visible = visibleSales(all, "u1", "member");
    expect(canEditSales(sharedOpp, visible, "u1", "member")).toBe(true);
    expect(canEditSales(sharedCall, visible, "u1", "member")).toBe(false);
    expect(canEditSales(doc, visible, "u1", "member")).toBe(false);
    expect(canEditSales(theirOpp, visible, "u1", "member")).toBe(false);
    expect(canEditSales(theirOpp, visible, "u1", "admin")).toBe(true);
    expect(canEditSales(mine, visible, "u1", "guest")).toBe(false);
  });
});

describe("quotes", () => {
  it("returns the exact fragment with speaker, time, context and source", () => {
    const [q] = findQuotes(
      seed.records.filter((r) => r.kind === "meeting"),
      "integración ERP",
    );
    expect(q).toMatchObject({
      sourceKind: "meeting",
      speaker: "Diego Paredes",
      time: "00:06:48",
      quote:
        "Mi preocupación es la integración con el ERP. Ya tuvimos un proyecto que se atrasó ocho meses.",
    });
    expect(q!.before).toContain("perdimos dos cadenas");
    expect(findQuotes(seed.records, "blockchain cuántico")).toEqual([]);
  });

  it("tells a verbatim quote from a paraphrase", () => {
    const src = "Tenemos cerca de un 7 por ciento de pedidos con errores.";
    expect(isVerbatim(src, "“cerca de un 7 por ciento de pedidos con errores”")).toBe(true);
    expect(isVerbatim(src, "casi un 7% de los pedidos falla")).toBe(false);
  });

  it("reads lines with and without time or speaker", () => {
    expect(
      transcriptLines(
        "Ana: hola\n[01:02] sin hablante\nnota suelta: con dos puntos y muchas palabras aquí",
      ),
    ).toMatchObject([
      { speaker: "Ana", text: "hola", time: "" },
      { speaker: "", time: "01:02", text: "sin hablante" },
      { speaker: "nota suelta", text: "con dos puntos y muchas palabras aquí" },
    ]);
  });
});

describe("coaching metrics", () => {
  const calls = seed.records.filter((r): r is SalesCall => r.kind === "call");
  it("counts the rep's share, questions and longest turn", () => {
    const m = callMetrics(calls.find((c) => c.id === "demo_call_3")!);
    expect(m.questions).toBe(4);
    expect(m.talkPct).toBeGreaterThan(40);
  });
  it("compares periods and says how many calls back each side", () => {
    const since = new Date(NOW - 30 * 86_400_000).toISOString().slice(0, 10);
    const t = coachingTrend(calls, since);
    expect([t.before.calls, t.after.calls]).toEqual([2, 2]);
    expect(t.rows.find((r) => r.metric.startsWith("Preguntas"))!.verdict).toBe("mejora");
    expect(t.rows.find((r) => r.metric.startsWith("Parte"))!.verdict).toBe("mejora");
  });
});

describe("duplicates, changes and export", () => {
  it("matches a company by domain or by name without its legal form", () => {
    const accounts = [
      { id: "a1", name: "Farmacias Andina S.A.", domain: "https://www.andina.test/" },
    ];
    expect(duplicateOf({ company: "FARMACIAS ANDINA" }, accounts)).toBe("a1");
    expect(duplicateOf({ company: "Otra", domain: "andina.test" }, accounts)).toBe("a1");
    expect(duplicateOf({ company: "Farmacias del Sur" }, accounts)).toBeNull();
    expect(companyKey("Grupo Éxito Cía. Ltda.")).toBe("n:exito");
  });
  it("lists the tracked fields that changed", () => {
    const o = opps[0]!;
    expect(salesDiff(o, { ...o, amount: 90_000, nextStep: "Llamar" })).toEqual([
      { field: "amount", from: "84000", to: "90000" },
      { field: "nextStep", from: "", to: "Llamar" },
    ]);
    expect(salesDiff(null, o)[0]!.field).toBe("creado");
  });
  it("exports a CSV that can't start a formula", () => {
    expect(salesCsv(["a", "b"], [["=1+1", 'x, "y"']])).toBe(`a,b\n'=1+1,"x, ""y"""`);
  });
});
