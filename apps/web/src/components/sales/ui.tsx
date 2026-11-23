import type { SalesRecord } from "@mindfultech/shared";
import { useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

// Ventas (Phase 73): small pieces every tab uses.

export const SALES_TABS = [
  ["panel", "Mi panel"],
  ["cuentas", "Clientes"],
  ["pronostico", "Pronóstico"],
  ["liderazgo", "Liderazgo"],
  ["prospeccion", "Prospección"],
  ["conocimiento", "Respuestas a clientes"],
  ["demo", "Demo guiada"],
] as const;
export type SalesTab = (typeof SALES_TABS)[number][0];

export interface SalesNav {
  tab: SalesTab;
  accountId: string;
  /** The result open on top (an artifact's id). */
  resultId: string;
  /** A record to bring into view within the tab. */
  focus: string;
  go: (to: { tab?: SalesTab; account?: string; result?: string; focus?: string }) => void;
  /** Opens the place where a record lives. */
  open: (record: Pick<SalesRecord, "id" | "kind"> & { accountId?: string }) => void;
}

/** Where the person is in Ventas, kept in the address so a link or the chat can open it. */
export function useSalesNav(): SalesNav {
  const [params, setParams] = useSearchParams();
  const tab = (SALES_TABS.find(([id]) => id === params.get("tab"))?.[0] ?? "panel") as SalesTab;
  const go = useCallback<SalesNav["go"]>(
    (to) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        const set = (key: string, value: string | undefined) => {
          if (value === undefined) return;
          if (value) next.set(key, value);
          else next.delete(key);
        };
        set("tab", to.tab);
        if (to.tab && to.account === undefined && to.tab !== "cuentas") next.delete("account");
        set("account", to.account);
        set("result", to.result);
        set("focus", to.focus);
        return next;
      }),
    [setParams],
  );
  const open = useCallback<SalesNav["open"]>(
    (r) => {
      if (r.kind === "account") go({ tab: "cuentas", account: r.id, focus: "" });
      else if (r.kind === "doc" || r.kind === "competitor")
        go({ tab: "conocimiento", focus: r.id });
      else go({ tab: "cuentas", account: r.accountId ?? "", focus: r.id });
    },
    [go],
  );
  return {
    tab,
    accountId: params.get("account") ?? "",
    resultId: params.get("result") ?? "",
    focus: params.get("focus") ?? "",
    go,
    open,
  };
}

export function Card({
  title,
  action,
  children,
  className = "",
}: Readonly<{ title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }>) {
  return (
    <section className={`rounded-xl border border-line bg-surface/60 ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {action}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: "bg-surface-hover text-ink-secondary",
  good: "bg-primary/15 text-primary",
  warn: "bg-warning/15 text-warning",
  bad: "bg-error/15 text-error",
  info: "bg-sky/15 text-sky",
} as const;
export function Badge({
  children,
  tone = "neutral",
  title,
}: Readonly<{ children: ReactNode; tone?: keyof typeof TONES; title?: string }>) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  onClick,
  tone,
}: Readonly<{
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
  tone?: "good" | "warn" | "bad";
}>) {
  const color =
    tone === "bad"
      ? "text-error"
      : tone === "warn"
        ? "text-warning"
        : tone === "good"
          ? "text-primary"
          : "text-ink";
  const body = (
    <>
      <p className="text-xs text-ink-secondary">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="text-xs text-ink-secondary">{hint}</p>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-line px-3 py-2.5 text-left hover:border-primary/60 hover:bg-surface-hover"
      title="Ver los registros que lo explican"
    >
      {body}
    </button>
  ) : (
    <div className="rounded-xl border border-line px-3 py-2.5">{body}</div>
  );
}

export function SmallButton({
  children,
  onClick,
  disabled,
  primary,
  title,
}: Readonly<{
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${
        primary
          ? "bg-primary text-white hover:bg-primary/90"
          : "border border-line text-ink hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

export const DemoTag = () => (
  <Badge tone="warn" title="Datos ficticios de la demo">
    DEMO
  </Badge>
);

export const Empty = ({ children }: Readonly<{ children: ReactNode }>) => (
  <p className="py-4 text-center text-sm text-ink-secondary">{children}</p>
);

export const fmtDay = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(d);
};
export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("es", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
};
