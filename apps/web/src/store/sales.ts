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
  state: SalesState | null;
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
  reset: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : "No se pudo completar.");

export const useSales = create<SalesStore>((set, get) => ({
  state: null,
  loading: false,
  error: null,
  running: null,
  load: async () => {
    set({ loading: true });
    try {
      set({ state: await salesApi.state(), error: null, loading: false });
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
      const state = get().state;
      if (state) {
        set({
          state: {
            ...state,
            artifacts: [artifact, ...state.artifacts.filter((a) => a.id !== artifact.id)],
          },
        });
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
      set({ state: await salesApi.resetDemo(), error: null, loading: false });
    } catch (err) {
      set({ error: message(err), loading: false });
      throw err;
    }
  },
  reset: () => set({ state: null, error: null, loading: false, running: null }),
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
