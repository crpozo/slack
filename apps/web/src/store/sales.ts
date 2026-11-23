import type {
  SalesAiInput,
  SalesArtifact,
  SalesFlow,
  SalesInput,
  SalesLead,
  SalesRecord,
  SalesState,
} from "@mindfultech/shared";
import { create } from "zustand";
import { salesApi } from "../lib/salesApi";

// Ventas (Phase 73): what the server lets this person see, and the calls that change it.

interface SalesStore {
  /** What the tabs show: `raw` without the demo's rows when the switch is off. */
  state: SalesState | null;
  /** What the server sent. */
  raw: SalesState | null;
  /** The "Datos demo" switch (this person's, kept in the browser). */
  showDemo: boolean;
  setShowDemo: (on: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
  /** The flow being generated (one at a time), by its key. */
  running: string | null;
  load: () => Promise<void>;
  save: (record: SalesInput) => Promise<SalesRecord>;
  remove: (id: string) => Promise<void>;
  ask: (input: SalesAiInput, key?: string) => Promise<SalesArtifact>;
  applyCrm: (
    key: string,
    updates: Array<{ recordId: string; field: string; value: string }>,
  ) => Promise<{ repeated: boolean; applied: Array<{ recordId: string; field: string }> }>;
  importLeads: (leads: SalesLead[]) => Promise<{ added: number; skipped: number }>;
  resetDemo: () => Promise<void>;
  clearDemo: () => Promise<void>;
  reset: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : "No se pudo completar.");

const DEMO_KEY = "slack.sales.demo";
function storedDemo(): boolean {
  try {
    return localStorage.getItem(DEMO_KEY) !== "off";
  } catch {
    return true;
  }
}
/** The state as shown: everything, or without the fictitious rows. */
const shown = (raw: SalesState, showDemo: boolean): SalesState =>
  showDemo
    ? raw
    : {
        ...raw,
        records: raw.records.filter((r) => !r.demo),
        artifacts: raw.artifacts.filter((a) => !a.demo),
        changes: raw.changes.filter((c) => !c.demo),
      };

export const useSales = create<SalesStore>((set, get) => ({
  state: null,
  raw: null,
  showDemo: storedDemo(),
  setShowDemo: async (on) => {
    try {
      localStorage.setItem(DEMO_KEY, on ? "on" : "off");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
    const { raw } = get();
    set({ showDemo: on, ...(raw && { state: shown(raw, on) }) });
    // Turned on with no demo on the server yet: load it.
    if (on && raw && !raw.records.some((r) => r.demo)) await get().resetDemo();
  },
  loading: false,
  error: null,
  running: null,
  load: async () => {
    set({ loading: true });
    try {
      const raw = await salesApi.state();
      set({ raw, state: shown(raw, get().showDemo), error: null, loading: false });
    } catch (err) {
      set({ error: message(err), loading: false });
    }
  },
  save: async (record) => {
    const saved = await salesApi.save(record);
    await get().load();
    return saved.record;
  },
  remove: async (id) => {
    await salesApi.remove(id);
    await get().load();
  },
  ask: async (input, key = input.flow) => {
    set({ running: key });
    try {
      const artifact = await salesApi.ask(input);
      const { raw, showDemo } = get();
      if (raw) {
        const next = {
          ...raw,
          artifacts: [artifact, ...raw.artifacts.filter((a) => a.id !== artifact.id)],
        };
        set({ raw: next, state: shown(next, showDemo) });
      }
      return artifact;
    } finally {
      set({ running: null });
    }
  },
  applyCrm: async (key, updates) => {
    const done = await salesApi.applyCrm(key, updates);
    await get().load();
    return done;
  },
  importLeads: async (leads) => {
    const done = await salesApi.importLeads(leads.map(({ fit: _fit, ...lead }) => lead));
    await get().load();
    return { added: done.added.length, skipped: done.skipped.length };
  },
  resetDemo: async () => {
    set({ loading: true });
    try {
      // Loading the demo is asking to see it.
      const raw = await salesApi.resetDemo();
      set({ raw, state: raw, showDemo: true, error: null, loading: false });
      try {
        localStorage.setItem(DEMO_KEY, "on");
      } catch {
        // Private mode.
      }
    } catch (err) {
      set({ error: message(err), loading: false });
      throw err;
    }
  },
  clearDemo: async () => {
    set({ loading: true });
    try {
      const raw = await salesApi.clearDemo();
      set({ raw, state: shown(raw, get().showDemo), error: null, loading: false });
    } catch (err) {
      set({ error: message(err), loading: false });
      throw err;
    }
  },
  reset: () => set({ state: null, raw: null, error: null, loading: false, running: null }),
}));

/** The latest result of `flow` about these records, if one was generated. */
export function artifactOf(
  artifacts: SalesArtifact[],
  flow: SalesFlow,
  refs: { accountId?: string; opportunityId?: string; meetingId?: string } = {},
): SalesArtifact | undefined {
  return artifacts
    .filter(
      (a) =>
        a.flow === flow &&
        (!refs.accountId || a.accountId === refs.accountId) &&
        (!refs.opportunityId || a.opportunityId === refs.opportunityId) &&
        (!refs.meetingId || a.meetingId === refs.meetingId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** A new record's id: short, unique, and sortable by when it was made. */
export const newSalesId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
