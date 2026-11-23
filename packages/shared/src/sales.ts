import { z } from "zod";
import type { Role } from "./roles";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): the team's sales assistant, in Spanish. Accounts,
// contacts, opportunities, meetings, calls, documents and competitors are
// rows of one table (`sales`); what a person sees is decided here
// (`visibleSales`) and applied by the server to every list, search, quote,
// export and generated result. Money, the forecast, priorities, quotes and
// duplicates are computed by this code, never by the model: the model writes
// the prose around them and cites the records it used.
// ---------------------------------------------------------------------------

export const SALES_KINDS = [
  "account",
  "contact",
  "opportunity",
  "meeting",
  "call",
  "doc",
  "competitor",
  "artifact",
] as const;
export type SalesKind = (typeof SALES_KINDS)[number];

export const SALES_STAGES = [
  "prospeccion",
  "descubrimiento",
  "propuesta",
  "negociacion",
  "cerrada_ganada",
  "cerrada_perdida",
] as const;
export type SalesStage = (typeof SALES_STAGES)[number];
export const SALES_STAGE_LABEL: Record<SalesStage, string> = {
  prospeccion: "Prospección",
  descubrimiento: "Descubrimiento",
  propuesta: "Propuesta",
  negociacion: "Negociación",
  cerrada_ganada: "Cerrada ganada",
  cerrada_perdida: "Cerrada perdida",
};
export const isOpenStage = (stage: SalesStage) =>
  stage !== "cerrada_ganada" && stage !== "cerrada_perdida";

/** The forecast categories of the system, as the rep sets them on an opportunity. */
export const FORECAST_CATEGORIES = ["commit", "best_case", "pipeline", "omitted"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];
export const FORECAST_LABEL: Record<ForecastCategory | "won", string> = {
  commit: "Comprometido",
  best_case: "Adicional (mejor caso)",
  pipeline: "Pipeline",
  omitted: "Fuera del pronóstico",
  won: "Cerrado ganado",
};

export const ACCOUNT_STATUSES = ["prospecto", "cliente", "en_riesgo", "inactivo"] as const;
export const ACCOUNT_STATUS_LABEL: Record<(typeof ACCOUNT_STATUSES)[number], string> = {
  prospecto: "Prospecto",
  cliente: "Cliente",
  en_riesgo: "En riesgo",
  inactivo: "Inactivo",
};
export const CONTACT_ROLES = [
  "decisor",
  "campeon",
  "influenciador",
  "usuario",
  "compras",
  "bloqueador",
] as const;
export const CONTACT_ROLE_LABEL: Record<(typeof CONTACT_ROLES)[number], string> = {
  decisor: "Decisor",
  campeon: "Campeón",
  influenciador: "Influenciador",
  usuario: "Usuario",
  compras: "Compras",
  bloqueador: "Bloqueador",
};

// --- ROI inputs (stored on the opportunity; the numbers are computed below) ---------

export const RoiInputsSchema = z.object({
  currency: z.string().trim().min(3).max(3).default("USD"),
  horizonMonths: z.number().int().min(1).max(120),
  /** One-time investment, paid at the start. */
  investment: z.number().min(0).max(1e12),
  /** What the solution costs every month from then on. */
  recurringMonthly: z.number().min(0).max(1e12),
  /** What the current situation costs every month (context; not in the formulas). */
  currentMonthlyCost: z.number().min(0).max(1e12).default(0),
  benefits: z
    .array(
      z.object({ name: z.string().trim().min(1).max(120), monthly: z.number().min(0).max(1e12) }),
    )
    .max(12),
  /** Months until the benefits are fully realised (linear ramp; 0: from the first month). */
  rampMonths: z.number().int().min(0).max(60).default(0),
  /** Share of the benefits each scenario achieves (1 = as estimated). */
  scenarios: z
    .object({
      conservador: z.number().min(0).max(5),
      base: z.number().min(0).max(5),
      optimista: z.number().min(0).max(5),
    })
    .default({ conservador: 0.6, base: 1, optimista: 1.25 }),
});
export type RoiInputs = z.infer<typeof RoiInputsSchema>;

// --- Records -------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max).default("");
const id = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .or(z.literal(""))
  .default("");

const base = {
  id,
  /** Whose it is: its rep. The server sets it to the caller on a new record unless an admin assigns it. */
  ownerId: z.string().max(128).default(""),
  ownerName: text(120),
  /** Where the data came from ("LinkedIn pegado el 2026-11-20", a URL), and its date. */
  source: text(500),
  sourceDate: day,
};

export const SalesRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("account"),
    name: z.string().trim().min(1).max(160),
    domain: text(200),
    industry: text(120),
    size: text(60),
    country: text(80),
    segment: text(80),
    status: z.enum(ACCOUNT_STATUSES).default("prospecto"),
    strategic: z.boolean().default(false),
    /** Who follows it on their watchlist. */
    watchers: z.array(z.string().max(128)).max(100).default([]),
    notes: text(6000),
  }),
  z.object({
    ...base,
    kind: z.literal("contact"),
    accountId: id,
    /** Empty when the person isn't identified yet: only the target title is known. */
    name: text(160),
    title: text(160),
    email: text(200),
    phone: text(60),
    role: z.enum(CONTACT_ROLES).or(z.literal("")).default(""),
    notes: text(2000),
  }),
  z.object({
    ...base,
    kind: z.literal("opportunity"),
    accountId: id,
    name: z.string().trim().min(1).max(160),
    type: z.enum(["nueva", "renovacion", "expansion"]).default("nueva"),
    amount: z.number().min(0).max(1e12).default(0),
    currency: z.string().trim().min(3).max(3).default("USD"),
    stage: z.enum(SALES_STAGES).default("prospeccion"),
    forecastCategory: z.enum(FORECAST_CATEGORIES).default("pipeline"),
    closeDate: day,
    nextStep: text(400),
    nextStepDate: day,
    /** What the buyer decides by, and how they decide (as documented by the rep). */
    criteria: text(3000),
    process: text(3000),
    risks: text(3000),
    roi: RoiInputsSchema.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("meeting"),
    accountId: id,
    opportunityId: id.or(z.literal("")).default(""),
    title: z.string().trim().min(1).max(200),
    /** ISO date-time. */
    date: z.string().max(40),
    attendees: text(1000),
    goal: text(1000),
    /** Notes or the transcript, pasted. Reference content, never instructions. */
    notes: text(60000),
  }),
  z.object({
    ...base,
    kind: z.literal("call"),
    accountId: id.or(z.literal("")).default(""),
    title: z.string().trim().min(1).max(200),
    date: z.string().max(40),
    /** The rep's name as it appears in the transcript ("Lucía:"). */
    repName: text(120),
    transcript: text(60000),
    /** The rep allows colleagues' coaching to quote this call as an example. */
    shareable: z.boolean().default(false),
  }),
  z.object({
    ...base,
    kind: z.literal("doc"),
    title: z.string().trim().min(1).max(200),
    body: text(60000),
    /** Who answers for this topic, when the document says. */
    expertName: text(120),
    tags: text(300),
    url: text(500),
  }),
  z.object({
    ...base,
    kind: z.literal("competitor"),
    name: z.string().trim().min(1).max(160),
    strengths: text(4000),
    weaknesses: text(4000),
    pricing: text(2000),
    notes: text(6000),
    url: text(500),
  }),
]);
export type SalesInput = z.input<typeof SalesRecordSchema>;
type Stamp = { createdAt: number; updatedAt: number; demo?: true };
export type SalesRecord = z.infer<typeof SalesRecordSchema> & Stamp;
export type SalesOf<K extends SalesRecord["kind"]> = Extract<SalesRecord, { kind: K }>;
export type SalesAccount = SalesOf<"account">;
export type SalesContact = SalesOf<"contact">;
export type SalesOpportunity = SalesOf<"opportunity">;
export type SalesMeeting = SalesOf<"meeting">;
export type SalesCall = SalesOf<"call">;
export type SalesDoc = SalesOf<"doc">;
export type SalesCompetitor = SalesOf<"competitor">;

/** One field of one record changing (the account's signals are these, in order). */
export interface SalesChange {
  id: string;
  recordKind: SalesRecord["kind"];
  recordId: string;
  /** The account it belongs to, when it has one. */
  accountId: string;
  /** What the record is called, for the list. */
  label: string;
  field: string;
  from: string;
  to: string;
  by: string;
  byName: string;
  at: number;
  demo?: true;
}

// --- What the assistant writes (one shape for every flow) ------------------------------

export const SALES_ITEM_KINDS = [
  "hecho",
  "hipotesis",
  "pendiente",
  "accion",
  "cita",
  "parafrasis",
] as const;
export type SalesItemKind = (typeof SALES_ITEM_KINDS)[number];
export const SALES_ITEM_LABEL: Record<SalesItemKind, string> = {
  hecho: "Hecho documentado",
  hipotesis: "Hipótesis por validar",
  pendiente: "Pendiente: faltan datos",
  accion: "Acción",
  cita: "Cita textual",
  parafrasis: "Paráfrasis",
};

export interface SalesItem {
  text: string;
  kind: SalesItemKind;
  /** The ids of the records that back it. */
  sources: string[];
  /** For a "cita": the exact fragment. The server checks it against the source. */
  quote: string;
  owner: string;
  due: string;
}
export interface SalesSlide {
  title: string;
  bullets: string[];
  notes: string;
  /** Rows of cells; the first is the header. */
  table?: string[][];
}
/** A change to the CRM the assistant proposes; nothing is written until the rep confirms. */
export interface SalesCrmUpdate {
  recordId: string;
  field: string;
  value: string;
  reason: string;
  sources: string[];
}
/** A company or contact found in pasted sources (prospecting). */
export interface SalesLead {
  company: string;
  domain: string;
  industry: string;
  country: string;
  size: string;
  contactName: string;
  contactTitle: string;
  email: string;
  fit: string;
  source: string;
}
export interface SalesResult {
  title: string;
  summary: string;
  sections: Array<{ heading: string; items: SalesItem[] }>;
  draft: { subject: string; body: string };
  crmUpdates: SalesCrmUpdate[];
  slides: SalesSlide[];
  leads: SalesLead[];
}
export const emptySalesResult = (title = ""): SalesResult => ({
  title,
  summary: "",
  sections: [],
  draft: { subject: "", body: "" },
  crmUpdates: [],
  slides: [],
  leads: [],
});

export const SALES_FLOWS = [
  "discovery",
  "outreach",
  "competitive",
  "answer",
  "prep",
  "agenda",
  "followup",
  "quotes",
  "coaching",
  "trends",
  "signals",
  "strategy",
  "deck",
] as const;
export type SalesFlow = (typeof SALES_FLOWS)[number];
export const SALES_FLOW_LABEL: Record<SalesFlow, string> = {
  discovery: "Descubrimiento y enriquecimiento",
  outreach: "Investigación y primer contacto",
  competitive: "Inteligencia competitiva",
  answer: "Respuesta interna",
  prep: "Preparación de la reunión",
  agenda: "Agenda de reuniones",
  followup: "Seguimiento de la reunión",
  quotes: "Citas textuales",
  coaching: "Coaching individual",
  trends: "Tendencias de coaching",
  signals: "Señales de la cuenta",
  strategy: "Estrategia de la oportunidad",
  deck: "Presentación comercial",
};

/** A generated result, kept so the next step finds it (same ids, same figures). */
export interface SalesArtifact {
  id: string;
  kind: "artifact";
  flow: SalesFlow;
  accountId: string;
  opportunityId: string;
  meetingId: string;
  /** Coaching: whose calls it's about. */
  repId?: string;
  ownerId: string;
  ownerName: string;
  result: SalesResult;
  createdAt: number;
  updatedAt: number;
  demo?: true;
}

/** `POST /sales/ai`. */
export const SalesAiSchema = z.object({
  flow: z.enum(SALES_FLOWS),
  accountId: z.string().max(64).default(""),
  opportunityId: z.string().max(64).default(""),
  meetingId: z.string().max(64).default(""),
  /** Coaching: whose calls. */
  repId: z.string().max(128).default(""),
  /** Trends: calls before this day against calls from it on. Signals: what changed since. */
  since: day,
  /** What the person asks or pastes: the question, the ICP and sources, the brief, the recipient. */
  input: z.string().trim().max(60000).default(""),
});
export type SalesAiInput = z.input<typeof SalesAiSchema>;

/** The fields a proposed CRM update may touch, by kind. */
export const CRM_FIELDS: Record<"opportunity" | "account", readonly string[]> = {
  opportunity: [
    "stage",
    "forecastCategory",
    "amount",
    "closeDate",
    "nextStep",
    "nextStepDate",
    "risks",
    "criteria",
    "process",
  ],
  account: ["status", "notes"],
};
export const CRM_FIELD_LABEL: Record<string, string> = {
  stage: "Etapa",
  forecastCategory: "Categoría de pronóstico",
  amount: "Monto",
  closeDate: "Fecha de cierre",
  nextStep: "Próximo paso",
  nextStepDate: "Fecha del próximo paso",
  risks: "Riesgos",
  criteria: "Criterios de decisión",
  process: "Proceso de decisión",
  status: "Estado",
  notes: "Notas",
  name: "Nombre",
  title: "Título",
  date: "Fecha",
  role: "Rol",
  ownerName: "Responsable",
  strategic: "Estratégica",
  email: "Correo",
  goal: "Objetivo",
};

/** `POST /sales/crm/apply`: the changes the rep confirmed, once (`key` makes a retry harmless). */
export const SalesCrmApplySchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  updates: z
    .array(
      z.object({
        recordId: id,
        field: z.string().max(40),
        value: z.string().max(3000),
      }),
    )
    .min(1)
    .max(20),
});

/** `POST /sales/import`: companies found while prospecting, as accounts and contacts. */
export const SalesImportSchema = z.object({
  leads: z
    .array(
      z.object({
        company: z.string().trim().min(1).max(160),
        domain: text(200),
        industry: text(120),
        country: text(80),
        size: text(60),
        contactName: text(160),
        contactTitle: text(160),
        email: text(200),
        source: text(500),
      }),
    )
    .min(1)
    .max(100),
});

export interface SalesState {
  records: SalesRecord[];
  artifacts: SalesArtifact[];
  changes: SalesChange[];
  /** The team (never externals), to assign and to filter by owner. */
  people: Array<{ userId: string; name: string }>;
}

// --- Permissions -----------------------------------------------------------------------

/** Ventas is for the team: never an external. */
export const canUseSales = (role: Role | undefined) => role === "member" || role === "admin";
/** The leadership panel and other people's forecast and coaching. */
export const leadsSales = (role: Role | undefined) => role === "admin";

/**
 * What `userId` may see of `records`: an admin, everything; a rep, their
 * accounts and what hangs from them, their own records, the shared knowledge
 * (documents, competitors) and the demo. A colleague's call only when it's
 * theirs to see (their account) or marked shareable.
 */
export function visibleSales<T extends { kind: string; ownerId: string; demo?: true }>(
  records: T[],
  userId: string,
  role: Role | undefined,
): T[] {
  if (!canUseSales(role)) return [];
  if (leadsSales(role)) return records;
  const mine = new Set(
    records.filter((r) => r.kind === "account" && r.ownerId === userId).map((r) => idOf(r)),
  );
  return records.filter((r) => {
    if (r.demo || r.ownerId === userId) return true;
    if (r.kind === "doc" || r.kind === "competitor") return true;
    if (r.kind === "account") return false;
    if (r.kind === "call" && (r as unknown as SalesCall).shareable) return true;
    const accountId = (r as unknown as { accountId?: string }).accountId;
    return !!accountId && mine.has(accountId);
  });
}
const idOf = (r: unknown) => (r as { id: string }).id;

/** Whether `userId` may change `record` (what they see, except colleagues' shareable calls and others' knowledge). */
export function canEditSales(
  record: { kind: string; ownerId: string; demo?: true },
  visible: Array<{ kind: string; ownerId: string }>,
  userId: string,
  role: Role | undefined,
): boolean {
  if (!canUseSales(role)) return false;
  if (leadsSales(role) || record.demo || record.ownerId === userId) return true;
  if (record.kind === "doc" || record.kind === "competitor" || record.kind === "call") return false;
  const accountId = (record as { accountId?: string }).accountId;
  return visible.some((r) => r.kind === "account" && idOf(r) === accountId && r.ownerId === userId);
}

// --- Money ---------------------------------------------------------------------------

const cents = (n: number) => Math.round(n * 100) / 100;

export function salesMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("es-EC", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export interface RoiScenario {
  /** Share of the estimated benefits this scenario achieves. */
  factor: number;
  totalBenefit: number;
  totalCost: number;
  net: number;
  /** (benefit − cost) ÷ cost, as a percentage; `null` when there is no cost. */
  roiPct: number | null;
  /** The first month whose accumulated net is zero or more; `null` if not within the horizon. */
  paybackMonth: number | null;
  /** Accumulated net at the end of each month, from month 0 (the investment). */
  cumulative: number[];
}
export interface RoiModel {
  inputs: RoiInputs;
  monthlyBenefit: number;
  scenarios: Record<"conservador" | "base" | "optimista", RoiScenario>;
}

/** The formulas, as shown next to the numbers. */
export const ROI_FORMULAS = [
  "Beneficio del mes m = suma de beneficios mensuales × factor del escenario × min(1, m ÷ meses de adopción)",
  "Costo total = inversión inicial + costo recurrente mensual × horizonte en meses",
  "Beneficio neto = beneficio total − costo total",
  "ROI = beneficio neto ÷ costo total",
  "Recuperación = primer mes en que el neto acumulado es cero o más",
];

export function roiScenario(inputs: RoiInputs, factor: number): RoiScenario {
  const monthly = inputs.benefits.reduce((n, b) => n + b.monthly, 0);
  const cumulative = [cents(-inputs.investment)];
  let totalBenefit = 0;
  let paybackMonth: number | null = inputs.investment === 0 ? 0 : null;
  for (let m = 1; m <= inputs.horizonMonths; m++) {
    const ramp = inputs.rampMonths > 0 ? Math.min(1, m / inputs.rampMonths) : 1;
    const benefit = monthly * factor * ramp;
    totalBenefit += benefit;
    const acc = cumulative[m - 1]! + benefit - inputs.recurringMonthly;
    cumulative.push(cents(acc));
    if (paybackMonth === null && acc >= 0) paybackMonth = m;
  }
  const totalCost = inputs.investment + inputs.recurringMonthly * inputs.horizonMonths;
  const net = totalBenefit - totalCost;
  return {
    factor,
    totalBenefit: cents(totalBenefit),
    totalCost: cents(totalCost),
    net: cents(net),
    roiPct: totalCost > 0 ? Math.round((net / totalCost) * 1000) / 10 : null,
    paybackMonth,
    cumulative,
  };
}

export function roiModel(raw: RoiInputs): RoiModel {
  const inputs = RoiInputsSchema.parse(raw);
  return {
    inputs,
    monthlyBenefit: cents(inputs.benefits.reduce((n, b) => n + b.monthly, 0)),
    scenarios: {
      conservador: roiScenario(inputs, inputs.scenarios.conservador),
      base: roiScenario(inputs, inputs.scenarios.base),
      optimista: roiScenario(inputs, inputs.scenarios.optimista),
    },
  };
}

const payback = (s: RoiScenario) =>
  s.paybackMonth === null ? "fuera del horizonte" : `mes ${s.paybackMonth}`;
const pct = (s: RoiScenario) => (s.roiPct === null ? "—" : `${s.roiPct}%`);

/** The decision deck of a business case: ten slides, every figure taken from `model`. */
export function roiDeck(
  account: Pick<SalesAccount, "name">,
  opportunity: Pick<SalesOpportunity, "name" | "nextStep" | "criteria">,
  model: RoiModel,
): SalesSlide[] {
  const { inputs, scenarios } = model;
  const $ = (n: number) => salesMoney(n, inputs.currency);
  const b = scenarios.base;
  const rows = (["conservador", "base", "optimista"] as const).map((name) => {
    const s = scenarios[name];
    return [
      name[0]!.toUpperCase() + name.slice(1),
      `${Math.round(s.factor * 100)}%`,
      $(s.totalBenefit),
      $(s.totalCost),
      $(s.net),
      pct(s),
      payback(s),
    ];
  });
  return [
    {
      title: `${opportunity.name}: caso de negocio`,
      bullets: [account.name, `Horizonte de análisis: ${inputs.horizonMonths} meses`],
      notes: "Portada. Decisión que se pide al final.",
    },
    {
      title: "Resumen para decidir",
      bullets: [
        `Beneficio neto esperado: ${$(b.net)} en ${inputs.horizonMonths} meses (escenario base)`,
        `ROI: ${pct(b)} · Recuperación de la inversión: ${payback(b)}`,
        `Inversión inicial: ${$(inputs.investment)} · Costo recurrente: ${$(inputs.recurringMonthly)} al mes`,
      ],
      notes: "Las cifras salen del modelo; los supuestos están en la diapositiva 5.",
    },
    {
      title: "Situación actual",
      bullets: [
        inputs.currentMonthlyCost > 0
          ? `Costo mensual de la situación actual: ${$(inputs.currentMonthlyCost)}`
          : "Costo de la situación actual: por documentar con el cliente",
        ...(opportunity.criteria ? [`Criterios de decisión: ${opportunity.criteria}`] : []),
      ],
      notes: "",
    },
    {
      title: "Inversión y costos",
      bullets: [
        `Inversión inicial (única): ${$(inputs.investment)}`,
        `Costo recurrente: ${$(inputs.recurringMonthly)} al mes`,
        `Costo total en ${inputs.horizonMonths} meses: ${$(b.totalCost)}`,
      ],
      notes: ROI_FORMULAS[1]!,
    },
    {
      title: "Beneficios y supuestos",
      bullets: [
        ...inputs.benefits.map((x) => `${x.name}: ${$(x.monthly)} al mes`),
        `Total estimado: ${$(model.monthlyBenefit)} al mes`,
        inputs.rampMonths > 0
          ? `Adopción gradual: beneficio completo desde el mes ${inputs.rampMonths}`
          : "Beneficio completo desde el primer mes",
      ],
      notes: "Supuestos editables: cada uno debe validarse con el cliente.",
    },
    {
      title: "Escenarios",
      bullets: [],
      table: [
        ["Escenario", "Beneficio logrado", "Beneficio", "Costo", "Neto", "ROI", "Recuperación"],
        ...rows,
      ],
      notes: "El factor es la parte de los beneficios estimados que se logra en cada escenario.",
    },
    {
      title: "Recuperación de la inversión",
      bullets: [
        `Escenario base: ${payback(b)}`,
        `Conservador: ${payback(scenarios.conservador)} · Optimista: ${payback(scenarios.optimista)}`,
        `Neto acumulado al mes ${inputs.horizonMonths}: ${$(b.cumulative[inputs.horizonMonths] ?? b.net)}`,
      ],
      notes: ROI_FORMULAS[4]!,
    },
    {
      title: "Cómo se calcula",
      bullets: ROI_FORMULAS,
      notes: "Transparencia del modelo: las mismas fórmulas del sistema.",
    },
    {
      title: "Riesgos y qué validar",
      bullets: [
        "Validar con el cliente cada beneficio mensual y su línea base",
        "Confirmar el tiempo de adopción con el equipo que lo usará",
        `Si solo se logra el ${Math.round(scenarios.conservador.factor * 100)}% del beneficio: neto de ${$(scenarios.conservador.net)}`,
      ],
      notes: "",
    },
    {
      title: "Decisión y próximos pasos",
      bullets: [
        `Aprobar una inversión de ${$(inputs.investment)} más ${$(inputs.recurringMonthly)} al mes`,
        opportunity.nextStep
          ? `Próximo paso: ${opportunity.nextStep}`
          : "Próximo paso: por acordar",
      ],
      notes: "",
    },
  ];
}

// --- Forecast ------------------------------------------------------------------------

export interface ForecastBucket {
  amount: number;
  /** The opportunities that add up to `amount`, each once. */
  ids: string[];
}
export interface ForecastTotals {
  currency: string;
  won: ForecastBucket;
  commit: ForecastBucket;
  best_case: ForecastBucket;
  pipeline: ForecastBucket;
  omitted: ForecastBucket;
}
export interface ForecastFilter {
  /** Close dates in [from, to], `YYYY-MM-DD`; empty: no bound. */
  from?: string;
  to?: string;
  ownerId?: string;
}

/** Which bucket an opportunity counts in: exactly one, or none (lost). */
export function forecastBucketOf(
  o: SalesOpportunity,
): keyof Omit<ForecastTotals, "currency"> | null {
  if (o.stage === "cerrada_ganada") return "won";
  if (o.stage === "cerrada_perdida") return null;
  return o.forecastCategory;
}

export function inForecast(o: SalesOpportunity, f: ForecastFilter): boolean {
  if (f.ownerId && o.ownerId !== f.ownerId) return false;
  if (f.from && (!o.closeDate || o.closeDate < f.from)) return false;
  if (f.to && (!o.closeDate || o.closeDate > f.to)) return false;
  return true;
}

/**
 * The forecast of `opportunities` in a period: per currency (never added
 * across currencies), per category, with the ids behind each total. An
 * opportunity listed twice counts once.
 */
export function forecastOf(
  opportunities: SalesOpportunity[],
  filter: ForecastFilter = {},
): ForecastTotals[] {
  const byCurrency = new Map<string, ForecastTotals>();
  const seen = new Set<string>();
  for (const o of opportunities) {
    if (seen.has(o.id) || !inForecast(o, filter)) continue;
    seen.add(o.id);
    const bucket = forecastBucketOf(o);
    if (!bucket) continue;
    const empty = (): ForecastBucket => ({ amount: 0, ids: [] });
    const totals =
      byCurrency.get(o.currency) ??
      ({
        currency: o.currency,
        won: empty(),
        commit: empty(),
        best_case: empty(),
        pipeline: empty(),
        omitted: empty(),
      } satisfies ForecastTotals);
    totals[bucket].amount = cents(totals[bucket].amount + o.amount);
    totals[bucket].ids.push(o.id);
    byCurrency.set(o.currency, totals);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface OppGap {
  /** What's missing or at risk, in Spanish. */
  text: string;
  /** The record that shows it (the opportunity itself, or a meeting). */
  recordId: string;
  severity: "riesgo" | "evidencia";
}

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What an open opportunity lacks to be believed, from the records alone. */
export function oppGaps(o: SalesOpportunity, records: SalesRecord[], now: number): OppGap[] {
  if (!isOpenStage(o.stage)) return [];
  const today = dayOf(now);
  const gaps: OppGap[] = [];
  const add = (text: string, severity: OppGap["severity"], recordId = o.id) =>
    gaps.push({ text, severity, recordId });
  if (!o.closeDate) add("Sin fecha de cierre", "evidencia");
  else if (o.closeDate < today) add(`La fecha de cierre (${o.closeDate}) ya pasó`, "riesgo");
  if (!o.nextStep) add("Sin próximo paso acordado", "riesgo");
  else if (o.nextStepDate && o.nextStepDate < today)
    add(`El próximo paso venció el ${o.nextStepDate}`, "riesgo");
  if (o.amount <= 0) add("Sin monto", "evidencia");
  const contacts = records.filter(
    (r): r is SalesContact => r.kind === "contact" && r.accountId === o.accountId,
  );
  if (!contacts.some((c) => c.role === "decisor" && c.name))
    add("No hay un decisor identificado en la cuenta", "evidencia");
  const meetings = records
    .filter((r): r is SalesMeeting => r.kind === "meeting" && r.accountId === o.accountId)
    .sort((a, b) => b.date.localeCompare(a.date));
  const last = meetings.find((m) => Date.parse(m.date) <= now);
  if (!last) add("Ninguna reunión registrada con la cuenta", "evidencia");
  else {
    const days = Math.floor((now - Date.parse(last.date)) / DAY_MS);
    if (days > 21) add(`Sin reuniones desde hace ${days} días`, "riesgo", last.id);
  }
  if (o.forecastCategory === "commit") {
    if (!o.criteria) add("Comprometida sin criterios de decisión documentados", "evidencia");
    if (!o.process) add("Comprometida sin proceso de decisión documentado", "evidencia");
  }
  if (o.risks) add(`Riesgo anotado: ${o.risks.split("\n")[0]}`, "riesgo");
  return gaps;
}

// --- The rep's priorities --------------------------------------------------------------

export interface SalesPriority {
  accountId: string;
  score: number;
  /** Why, each with the record that justifies it. */
  reasons: Array<{ text: string; recordKind: SalesRecord["kind"]; recordId: string }>;
}

/** This week's accounts in order, with the reasons (rules over the records; no model). */
export function salesPriorities(
  records: SalesRecord[],
  changes: SalesChange[],
  ownerId: string | null,
  now: number,
): SalesPriority[] {
  const week = dayOf(now + 7 * DAY_MS);
  const today = dayOf(now);
  const byAccount = new Map<string, SalesPriority>();
  const at = (accountId: string) => {
    const p = byAccount.get(accountId) ?? { accountId, score: 0, reasons: [] };
    byAccount.set(accountId, p);
    return p;
  };
  const accounts = records.filter(
    (r): r is SalesAccount => r.kind === "account" && (!ownerId || r.ownerId === ownerId),
  );
  const ids = new Set(accounts.map((a) => a.id));
  for (const r of records) {
    if (r.kind === "opportunity" && ids.has(r.accountId) && isOpenStage(r.stage)) {
      const p = at(r.accountId);
      const gaps = oppGaps(r, records, now).filter((g) => g.severity === "riesgo");
      const weight =
        r.forecastCategory === "commit" ? 3 : r.forecastCategory === "best_case" ? 2 : 1;
      if (r.closeDate && r.closeDate <= dayOf(now + 30 * DAY_MS)) {
        p.score += 2 * weight;
        p.reasons.push({
          text: `${r.name} (${salesMoney(r.amount, r.currency)}, ${FORECAST_LABEL[r.forecastCategory]}) cierra el ${r.closeDate}`,
          recordKind: "opportunity",
          recordId: r.id,
        });
      }
      for (const g of gaps) {
        p.score += 2 * weight;
        p.reasons.push({
          text: `${r.name}: ${g.text}`,
          recordKind: g.recordId === r.id ? "opportunity" : "meeting",
          recordId: g.recordId,
        });
      }
    }
    if (r.kind === "meeting" && ids.has(r.accountId)) {
      const d = r.date.slice(0, 10);
      if (d >= today && d <= week) {
        const p = at(r.accountId);
        p.score += 3;
        p.reasons.push({
          text: `Reunión el ${d}: ${r.title}`,
          recordKind: "meeting",
          recordId: r.id,
        });
      }
    }
  }
  for (const a of accounts) {
    if (a.status === "en_riesgo") {
      const p = at(a.id);
      p.score += 3;
      p.reasons.push({ text: "Cuenta marcada en riesgo", recordKind: "account", recordId: a.id });
    }
    const recent = changes.filter((c) => c.accountId === a.id && c.at >= now - 7 * DAY_MS);
    if (recent.length) {
      const p = at(a.id);
      p.score += 1;
      p.reasons.push({
        text: `${recent.length} ${recent.length === 1 ? "cambio" : "cambios"} en los últimos 7 días`,
        recordKind: recent[0]!.recordKind,
        recordId: recent[0]!.recordId,
      });
    }
  }
  return [...byAccount.values()].filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
}

// --- Quotes --------------------------------------------------------------------------

export interface TranscriptLine {
  index: number;
  /** "00:12:30", when the line has it. */
  time: string;
  speaker: string;
  text: string;
  /** The line exactly as written. */
  raw: string;
}

const LINE =
  /^\s*(?:[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*[-–]?\s*)?(?:([^:\n]{1,40}?):\s+)?(.*)$/;

/** A transcript or notes, line by line: time and speaker when the line gives them. */
export function transcriptLines(text: string): TranscriptLine[] {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw, index) => {
      const m = LINE.exec(raw);
      const speaker = (m?.[2] ?? "").trim();
      // "https://…" or a sentence with a colon isn't a speaker.
      const named = speaker && !/^https?$/i.test(speaker) && speaker.split(/\s+/).length <= 4;
      return {
        index,
        time: m?.[1] ?? "",
        speaker: named ? speaker : "",
        text:
          named || m?.[1] ? (named ? m![3]! : `${speaker ? `${speaker}: ` : ""}${m![3]!}`) : raw,
        raw,
      };
    });
}

/** Lower case, no accents, single spaces: how two texts are compared. */
export const foldText = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Whether `quote` is in `source` word for word (case, accents and spacing aside). */
export function isVerbatim(source: string, quote: string): boolean {
  const q = foldText(quote).replace(/^["“”'«»]+|["“”'«»]+$/g, "");
  return q.length >= 8 && foldText(source).includes(q);
}

export interface SalesQuote {
  sourceId: string;
  sourceKind: "meeting" | "call" | "doc";
  sourceTitle: string;
  sourceDate: string;
  speaker: string;
  time: string;
  /** The exact fragment. */
  quote: string;
  /** The lines around it. */
  before: string;
  after: string;
  score: number;
}

const STOP = new Set(
  "de la el los las un una y o que en a por con para del al se su es lo como mas no si sobre the of and".split(
    " ",
  ),
);

/** The exact fragments of meetings, calls and documents that mention `query`, best first. */
export function findQuotes(records: SalesRecord[], query: string, limit = 20): SalesQuote[] {
  const terms = foldText(query)
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
  if (terms.length === 0) return [];
  const found: SalesQuote[] = [];
  for (const r of records) {
    if (r.kind !== "meeting" && r.kind !== "call" && r.kind !== "doc") continue;
    const body = r.kind === "meeting" ? r.notes : r.kind === "call" ? r.transcript : r.body;
    if (!body) continue;
    const lines = transcriptLines(body);
    for (const line of lines) {
      const folded = foldText(line.text);
      const hits = terms.filter((t) => folded.includes(t)).length;
      if (hits === 0 || (terms.length > 1 && hits < Math.ceil(terms.length / 2))) continue;
      found.push({
        sourceId: r.id,
        sourceKind: r.kind,
        sourceTitle: r.title,
        sourceDate: (r.kind === "doc" ? r.sourceDate : r.date).slice(0, 10),
        speaker: line.speaker,
        time: line.time,
        quote: line.text,
        before: lines[line.index - 1]?.raw ?? "",
        after: lines[line.index + 1]?.raw ?? "",
        score: hits / terms.length,
      });
    }
  }
  return found
    .sort((a, b) => b.score - a.score || b.sourceDate.localeCompare(a.sourceDate))
    .slice(0, limit);
}

// --- Coaching metrics ------------------------------------------------------------------

export interface CallMetrics {
  /** Share of the words the rep said, 0–100. */
  talkPct: number;
  /** Questions the rep asked. */
  questions: number;
  /** The rep's longest turn, in words. */
  longestTurn: number;
  turns: number;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** What a call's transcript shows about how the rep spoke (counted, not judged). */
export function callMetrics(call: Pick<SalesCall, "transcript" | "repName">): CallMetrics {
  const rep = foldText(call.repName);
  let mine = 0;
  let all = 0;
  let questions = 0;
  let longest = 0;
  let turns = 0;
  for (const line of transcriptLines(call.transcript)) {
    const n = words(line.text);
    all += n;
    if (rep && foldText(line.speaker) === rep) {
      mine += n;
      turns++;
      questions += (line.text.match(/\?/g) ?? []).length;
      longest = Math.max(longest, n);
    }
  }
  return {
    talkPct: all ? Math.round((mine / all) * 100) : 0,
    questions,
    longestTurn: longest,
    turns,
  };
}

export interface CoachingTrend {
  before: { calls: number; ids: string[] } & CallMetrics;
  after: { calls: number; ids: string[] } & CallMetrics;
  rows: Array<{
    metric: string;
    before: number;
    after: number;
    /** For talk share and long turns, lower is better. */
    verdict: "mejora" | "retroceso" | "estable";
  }>;
}

/** A rep's calls before `since` against those from it on: averages, and how many calls back each. */
export function coachingTrend(calls: SalesCall[], since: string): CoachingTrend {
  const side = (list: SalesCall[]) => {
    const m = list.map(callMetrics);
    const avg = (pick: (x: CallMetrics) => number) =>
      m.length ? Math.round(m.reduce((n, x) => n + pick(x), 0) / m.length) : 0;
    return {
      calls: list.length,
      ids: list.map((c) => c.id),
      talkPct: avg((x) => x.talkPct),
      questions: avg((x) => x.questions),
      longestTurn: avg((x) => x.longestTurn),
      turns: avg((x) => x.turns),
    };
  };
  const before = side(calls.filter((c) => c.date.slice(0, 10) < since));
  const after = side(calls.filter((c) => c.date.slice(0, 10) >= since));
  const verdict = (b: number, a: number, lowerIsBetter: boolean, tolerance: number) =>
    Math.abs(a - b) <= tolerance
      ? ("estable" as const)
      : a < b === lowerIsBetter
        ? ("mejora" as const)
        : ("retroceso" as const);
  return {
    before,
    after,
    rows: [
      {
        metric: "Parte de la conversación que habla el vendedor (%)",
        before: before.talkPct,
        after: after.talkPct,
        verdict: verdict(before.talkPct, after.talkPct, true, 3),
      },
      {
        metric: "Preguntas por llamada",
        before: before.questions,
        after: after.questions,
        verdict: verdict(before.questions, after.questions, false, 0),
      },
      {
        metric: "Intervención más larga (palabras)",
        before: before.longestTurn,
        after: after.longestTurn,
        verdict: verdict(before.longestTurn, after.longestTurn, true, 10),
      },
    ],
  };
}

// --- Duplicates, changes, export -------------------------------------------------------

const LEGAL =
  /\b(s\.?a\.?s?|c\.?a\.?|cia\.?|ltda\.?|inc\.?|llc|corp\.?|s\.?r\.?l\.?|group|grupo)\b/g;

/** What makes two companies the same one: the domain, else the name without its legal form. */
export function companyKey(name: string, domain = ""): string {
  const d = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .trim();
  if (d) return `d:${d}`;
  return `n:${foldText(name)
    .replace(LEGAL, "")
    .replace(/[^a-z0-9ñ]/g, "")}`;
}

/** Whether a company is already an account (by domain or by name). */
export function duplicateOf(
  lead: { company: string; domain?: string },
  accounts: Array<Pick<SalesAccount, "id" | "name" | "domain">>,
): string | null {
  const keys = new Set([companyKey(lead.company, lead.domain), companyKey(lead.company)]);
  return (
    accounts.find((a) => keys.has(companyKey(a.name, a.domain)) || keys.has(companyKey(a.name)))
      ?.id ?? null
  );
}

const TRACKED = [
  "name",
  "title",
  "status",
  "strategic",
  "stage",
  "forecastCategory",
  "amount",
  "currency",
  "closeDate",
  "nextStep",
  "nextStepDate",
  "risks",
  "criteria",
  "process",
  "role",
  "email",
  "date",
  "goal",
  "ownerName",
] as const;

/** The tracked fields that differ between two versions of a record (`before` null: it's new). */
export function salesDiff(
  before: SalesRecord | null,
  after: SalesRecord,
): Array<{ field: string; from: string; to: string }> {
  if (!before) return [{ field: "creado", from: "", to: salesLabel(after) }];
  const out: Array<{ field: string; from: string; to: string }> = [];
  for (const field of TRACKED) {
    const a = String((before as Record<string, unknown>)[field] ?? "");
    const b = String((after as Record<string, unknown>)[field] ?? "");
    if (field in after && a !== b) out.push({ field, from: a, to: b });
  }
  return out;
}

export const salesLabel = (r: SalesRecord): string =>
  r.kind === "account" || r.kind === "competitor" || r.kind === "opportunity"
    ? r.name
    : r.kind === "contact"
      ? r.name || `${r.title} (por identificar)`
      : r.title;

/** A table as CSV (quoted when needed; a cell can't start a formula). */
export function salesCsv(header: string[], rows: Array<Array<string | number>>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
