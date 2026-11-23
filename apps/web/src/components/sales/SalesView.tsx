import {
  canUseSales,
  foldText,
  isOpenStage,
  leadsSales,
  type SalesAccount,
  type SalesRecord,
} from "@mindfultech/shared";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { SalesAction } from "../../lib/commands";
import { tasksApiConfigured } from "../../lib/tasksApi";
import { useChat } from "../../store";
import { useSales } from "../../store/sales";
import { MenuIcon } from "../icons";
import { AccountsTab } from "./Accounts";
import { DashboardTab, ForecastTab, LeadershipTab } from "./Panels";
import { ResultModal } from "./Result";
import { CoachingTab, DemoTab, KnowledgeTab, ProspectingTab } from "./Tools";
import { SALES_TABS, useSalesNav } from "./ui";

/**
 * `/ventas preparar Acme` from the chat (`?q=Acme&do=preparar`): finds the
 * account by name among what the person sees, opens it and starts that flow
 * on its nearest meeting or its open opportunity. Once per address.
 */
function useSalesCommand() {
  const [params, setParams] = useSearchParams();
  const state = useSales((s) => s.state);
  const ask = useSales((s) => s.ask);
  const showToast = useChat((s) => s.showToast);
  const q = params.get("q");
  const action = params.get("do");
  const handled = useRef("");
  useEffect(() => {
    if (!state || !q || handled.current === `${q}|${action}`) return;
    handled.current = `${q}|${action}`;
    const wanted = foldText(q);
    const account = state.records.find(
      (r): r is SalesAccount => r.kind === "account" && foldText(r.name).includes(wanted),
    );
    const next = new URLSearchParams(params);
    next.delete("q");
    next.delete("do");
    if (!account) {
      setParams(next, { replace: true });
      showToast(`No encontré un cliente llamado «${q}» entre las que ves.`, "info");
      return;
    }
    next.set("tab", "cuentas");
    next.set("account", account.id);
    setParams(next, { replace: true });
    const of = <K extends SalesRecord["kind"]>(kind: K) =>
      state.records.filter(
        (r): r is Extract<SalesRecord, { kind: K }> =>
          r.kind === kind && "accountId" in r && r.accountId === account.id,
      );
    const now = Date.now();
    const meetings = of("meeting").sort((a, b) => a.date.localeCompare(b.date));
    const opp = of("opportunity").find((o) => isOpenStage(o.stage));
    const meeting =
      action === "preparar"
        ? meetings.find((m) => Date.parse(m.date) >= now)
        : action === "seguimiento"
          ? [...meetings].reverse().find((m) => Date.parse(m.date) < now && m.notes)
          : undefined;
    const flows: Partial<Record<SalesAction, "prep" | "followup" | "strategy" | "signals">> = {
      preparar: "prep",
      seguimiento: "followup",
      estrategia: "strategy",
      senales: "signals",
    };
    const flow = flows[action as SalesAction];
    if (!flow) return;
    if ((flow === "prep" || flow === "followup") && !meeting) {
      showToast(
        flow === "prep"
          ? "Ese cliente no tiene una reunión próxima."
          : "Ese cliente no tiene una reunión con notas.",
        "info",
      );
      return;
    }
    if (flow === "strategy" && !opp) {
      showToast("Ese cliente no tiene una oportunidad abierta.", "info");
      return;
    }
    void ask({
      flow,
      accountId: account.id,
      ...(meeting && { meetingId: meeting.id, opportunityId: meeting.opportunityId }),
      ...(flow === "strategy" && opp && { opportunityId: opp.id }),
    }).then(
      (artifact) => {
        // From the address as this effect left it (the router's updater sees a stale one).
        const withResult = new URLSearchParams(next);
        withResult.set("result", artifact.id);
        setParams(withResult, { replace: true });
      },
      (err: unknown) =>
        showToast(err instanceof Error ? err.message : "El asistente no pudo responder.", "error"),
    );
  }, [state, q, action, params, setParams, ask, showToast]);
}

/**
 * Ventas (`/app/sales`, Phase 73): the team's sales assistant, in Spanish.
 * The tab, the account and the open result are in the address (`?tab=…`), so
 * a step of the demo or `/ventas` in the chat opens the right place.
 */
export function SalesView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const nav = useSalesNav();
  const state = useSales((s) => s.state);
  const error = useSales((s) => s.error);
  const loading = useSales((s) => s.loading);
  const load = useSales((s) => s.load);
  const allowed = canUseSales(me?.role) && tasksApiConfigured();
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);
  useSalesCommand();
  const tabs = SALES_TABS.filter(([id]) => id !== "liderazgo" || leadsSales(me?.role));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-sales-view>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover md:hidden"
            aria-label="Abrir el menú"
          >
            <MenuIcon />
          </button>
        )}
        <h1 className="text-base font-bold text-ink">Ventas</h1>
        <span className="hidden text-xs text-ink-secondary sm:inline">Asistente comercial</span>
        {loading && state && (
          <span className="ml-auto text-xs text-ink-secondary" aria-live="polite">
            Actualizando…
          </span>
        )}
      </header>
      {!allowed ? (
        <p className="p-6 text-sm text-ink-secondary">
          {canUseSales(me?.role)
            ? "Ventas no está configurado en este despliegue."
            : "Ventas es para el equipo de MindfulTech."}
        </p>
      ) : (
        <>
          <nav
            className="shrink-0 overflow-x-auto border-b border-line px-2 sm:px-3"
            aria-label="Secciones de Ventas"
          >
            <div role="tablist" className="flex gap-1 py-1.5">
              {tabs.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={nav.tab === id}
                  onClick={() => nav.go({ tab: id, account: "", focus: "", result: "" })}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold ${nav.tab === id ? "bg-primary/15 text-primary" : "text-ink-secondary hover:bg-surface-hover hover:text-ink"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>
          <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <div className="mx-auto max-w-5xl">
              {error && (
                <p
                  role="alert"
                  className="mb-3 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
                >
                  {error}
                </p>
              )}
              {!state ? (
                !error && (
                  <p className="text-sm text-ink-secondary" aria-busy="true">
                    Cargando…
                  </p>
                )
              ) : nav.tab === "cuentas" ? (
                <AccountsTab />
              ) : nav.tab === "pronostico" ? (
                <ForecastTab />
              ) : nav.tab === "liderazgo" ? (
                <LeadershipTab />
              ) : nav.tab === "prospeccion" ? (
                <ProspectingTab />
              ) : nav.tab === "conocimiento" ? (
                <KnowledgeTab />
              ) : nav.tab === "coaching" ? (
                <CoachingTab />
              ) : nav.tab === "demo" ? (
                <DemoTab />
              ) : (
                <DashboardTab />
              )}
            </div>
          </main>
          {state && <ResultModal />}
        </>
      )}
    </div>
  );
}
