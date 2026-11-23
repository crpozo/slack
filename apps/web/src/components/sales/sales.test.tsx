// @vitest-environment jsdom
import {
  DEMO_ACCOUNT_ID,
  DEMO_OPP_ID,
  DEMO_ROI,
  demoSalesSeed,
  roiModel,
  salesMoney,
  type SalesState,
} from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { salesCommandPath } from "../../lib/commands";
import { salesApi } from "../../lib/salesApi";
import { configureTasksApi } from "../../lib/tasksApi";
import { useChat } from "../../store";
import { useSales } from "../../store/sales";
import { SalesView } from "./SalesView";

// Phase 73: Ventas, from where each flow starts. The demo's tour, the ROI's
// figures on the page and in the deck, and the CRM change confirmed once.

let state: SalesState;
let where = "";
function Where() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}
const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`not there yet: ${selector}`);
    return el;
  });
const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SalesView />
      <Where />
    </MemoryRouter>,
  );

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  Element.prototype.scrollIntoView ??= () => {};
  configureTasksApi("https://api.fake.example");
  state = {
    ...demoSalesSeed(Date.now()),
    people: [{ userId: "u-rep", name: "Rep" }],
    projects: [],
  };
  vi.spyOn(salesApi, "state").mockImplementation(() => Promise.resolve(state));
  useSales.getState().reset();
  useSales.setState({ showDemo: true });
  useChat.setState({ me: { userId: "u-rep", email: "r@x.test", role: "member" } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the guided demo, on the page", () => {
  it("from the committed total to the opportunity, its follow-up and the confirmed CRM change", async () => {
    open("/app/sales?tab=pronostico");
    // 1. The committed total, traceable to its opportunities.
    const commit = await screen.findByRole("button", { name: /Comprometido/ });
    expect(commit.textContent).toContain(salesMoney(120_000));
    expect(commit.textContent).toContain("2 oportunidades");
    fireEvent.click(commit);
    const drill = await found("[data-sales-drill]");
    expect(within(drill).getByText("Sin próximo paso acordado")).toBeTruthy();
    // 2. The opportunity, in its account: same amount, same owner.
    fireEvent.click(within(drill).getByText("Plataforma de pedidos B2B (DEMO)"));
    await waitFor(() => expect(where).toContain(`account=${DEMO_ACCOUNT_ID}`));
    const opp = document.querySelector(`[data-sales-opp="${DEMO_OPP_ID}"]`) as HTMLElement;
    expect(opp.querySelector("[data-sales-amount]")!.textContent).toBe(salesMoney(84_000));
    expect(opp.textContent).toContain("Lucía Vera (DEMO)");
    expect(screen.getAllByText("DEMO").length).toBeGreaterThan(0);
    // 3. The meeting's follow-up: exact quotes, an editable draft, the proposed change.
    fireEvent.click(screen.getByRole("button", { name: "Ver: Seguimiento" }));
    const proposal = await found("[data-crm-proposal]");
    expect(screen.getByText("«Mi preocupación es la integración con el ERP.»")).toBeTruthy();
    const draft = screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Hola Marta: editado." } });
    expect(draft.value).toBe("Hola Marta: editado.");
    expect(proposal.textContent).toContain("Nada se ha guardado");
    expect(proposal.textContent).toContain("Comprometido");
    expect(proposal.textContent).toContain("Adicional (mejor caso)");
    // 4. Confirmed: exactly those changes, with a key that makes a retry harmless.
    const apply = vi
      .spyOn(salesApi, "applyCrm")
      .mockResolvedValue({ applied: [], repeated: false });
    const confirm = within(proposal).getByRole("button", { name: "Confirmar y aplicar 4 cambios" });
    fireEvent.click(confirm);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const [key, updates] = apply.mock.calls[0]!;
    expect(updates).toContainEqual({
      recordId: DEMO_OPP_ID,
      field: "forecastCategory",
      value: "best_case",
    });
    expect(updates.every((u) => u.recordId === DEMO_OPP_ID)).toBe(true);
    fireEvent.click(within(proposal).getByRole("button", { name: /Confirmar y aplicar/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]![0]).toBe(key);
  });

  it("the business case shows the model's figures and reuses them in the deck", async () => {
    open(`/app/sales?tab=cuentas&account=${DEMO_ACCOUNT_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Caso de negocio y ROI" }));
    const base = roiModel(DEMO_ROI).scenarios.base;
    const row = await found('[data-roi-scenario="base"]');
    expect(row.textContent).toContain(salesMoney(base.net));
    expect(row.textContent).toContain(`${base.roiPct}%`);
    expect(row.textContent).toContain(`Mes ${base.paybackMonth}`);
    // An assumption changes: the numbers follow.
    fireEvent.change(screen.getByLabelText("Inversión inicial"), { target: { value: "100000" } });
    const changed = roiModel({ ...DEMO_ROI, investment: 100_000 }).scenarios.base;
    expect(row.textContent).toContain(salesMoney(changed.net));
    fireEvent.click(screen.getByRole("button", { name: "Convertir en presentación de decisión" }));
    const slides = document.querySelector("[data-sales-slides]") as HTMLElement;
    expect(slides.textContent).toContain("10 diapositivas");
    const all = [...slides.querySelectorAll("textarea")].map((t) => t.value).join("\n");
    expect(all).toContain(salesMoney(changed.net));
    expect(all).toContain(`mes ${changed.paybackMonth}`);
    expect(within(slides).getByRole("button", { name: "Exportar a PowerPoint" })).toBeTruthy();
  });

  it("the demo tab walks the same account and can be reset", async () => {
    const reset = vi.spyOn(salesApi, "resetDemo").mockImplementation(() => Promise.resolve(state));
    open("/app/sales?tab=demo");
    const steps = await found("[data-sales-demo-steps]");
    expect(steps.querySelectorAll("li")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Ver la preparación" }));
    await waitFor(() => expect(where).toContain("result=demo_art_prep"));
    expect(await screen.findByText(/Tenemos cerca de un 7 por ciento/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Cerrar" })[0]!);
    fireEvent.click(screen.getByRole("tab", { name: "Demo guiada" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reiniciar demo" }));
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });
});

describe("the client's project in the platform (Phase 75)", () => {
  const project = {
    channelId: "ch_cam",
    name: "Cambridge",
    hasExternals: true,
    clientNames: ["Ana"],
    people: 2,
    hours30: 40,
    hoursPrev30: 20,
    hoursTotal: 300,
    lastEntry: new Date().toISOString().slice(0, 10),
  };
  it("a project channel becomes a client in one click, linked to its hours", async () => {
    state = { ...state, projects: [project] };
    const save = vi.spyOn(salesApi, "save").mockImplementation((record) => {
      const saved = { ...state.records[0]!, ...record, demo: undefined } as never;
      state = { ...state, records: [...state.records, saved] };
      return Promise.resolve({ record: saved, changes: [] });
    });
    open("/app/sales?tab=cuentas");
    const list = await found("[data-sales-unlinked]");
    expect(list.textContent).toContain("#Cambridge");
    expect(list.textContent).toContain("40 h en 30 días");
    fireEvent.click(within(list).getByRole("button", { name: "Crear cliente" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      kind: "account",
      name: "Cambridge",
      status: "cliente",
      channelId: "ch_cam",
      source: "Canal #Cambridge de la plataforma",
    });
    // Its page shows the project's hours and what they signal; no money for a rep.
    const card = await found('[data-sales-project="ch_cam"]');
    expect(card.textContent).toContain("40 h");
    expect(card.textContent).not.toContain("Facturable");
    expect(screen.getByText(/Las horas subieron de 20 a 40/)).toBeTruthy();
  });
});

describe("the demo data switch", () => {
  it("hides the fictitious rows for this person, and brings them back", async () => {
    localStorage.removeItem("slack.sales.demo");
    useSales.setState({ showDemo: true });
    open("/app/sales?tab=cuentas");
    await screen.findByText("Farmacias Andina (DEMO · ficticia)");
    const toggle = screen.getByRole("switch", { name: "Datos demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("Farmacias Andina (DEMO · ficticia)")).toBeNull(),
    );
    expect(localStorage.getItem("slack.sales.demo")).toBe("off");
    expect(screen.queryAllByText("DEMO")).toHaveLength(0);
    // Nothing was deleted on the server: on again, they're back without a reload.
    const reset = vi.spyOn(salesApi, "resetDemo");
    fireEvent.click(toggle);
    await screen.findByText("Farmacias Andina (DEMO · ficticia)");
    expect(reset).not.toHaveBeenCalled();
  });

  it("turned on with no demo on the server, loads it", async () => {
    const seeded = state;
    state = { ...state, records: [], artifacts: [], changes: [] };
    useSales.setState({ showDemo: false });
    const reset = vi.spyOn(salesApi, "resetDemo").mockImplementation(() => Promise.resolve(seeded));
    open("/app/sales?tab=cuentas");
    fireEvent.click(await screen.findByRole("switch", { name: "Datos demo" }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    await screen.findByText("Farmacias Andina (DEMO · ficticia)");
  });
});

describe("who gets in, and from the chat", () => {
  it("an external sees nothing; a rep has no leadership tab", async () => {
    open("/app/sales");
    await screen.findByRole("tab", { name: "Mi panel" });
    expect(screen.queryByRole("tab", { name: "Liderazgo" })).toBeNull();
    cleanup();
    useChat.setState({ me: { userId: "u-ext", email: "e@x.test", role: "guest" } });
    useSales.getState().reset();
    vi.mocked(salesApi.state).mockClear();
    open("/app/sales");
    expect(screen.getByText("Ventas es para el equipo de MindfulTech.")).toBeTruthy();
    expect(salesApi.state).not.toHaveBeenCalled();
  });

  it("/ventas goes to a section, or starts a flow on an account by name", async () => {
    expect(salesCommandPath("")).toBe("/app/sales");
    expect(salesCommandPath("Pronóstico")).toBe("/app/sales?tab=pronostico");
    expect(salesCommandPath("preparar Farmacias Andina")).toBe(
      "/app/sales?tab=cuentas&q=Farmacias+Andina&do=preparar",
    );
    const ask = vi
      .spyOn(salesApi, "ask")
      .mockImplementation((input) =>
        Promise.resolve({ ...state.artifacts[0]!, id: "art_new", flow: input.flow }),
      );
    open(salesCommandPath("preparar farmacias andina"));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0]![0]).toMatchObject({
      flow: "prep",
      accountId: DEMO_ACCOUNT_ID,
      meetingId: "demo_meet_andina_next",
      opportunityId: DEMO_OPP_ID,
    });
    await waitFor(() => expect(where).toContain("result=art_new"));
    expect(where).toContain(`account=${DEMO_ACCOUNT_ID}`);
    expect(where).not.toContain("q=");
  });
});
