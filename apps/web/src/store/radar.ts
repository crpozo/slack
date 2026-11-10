import type {
  CreateBlipInput,
  RadarBlip,
  RadarProposal,
  RadarRing,
  UpdateBlipInput,
} from "@mindfultech/shared";
import { create } from "zustand";
import { radarApi } from "../lib/radarApi";

export type RadarStatus = "idle" | "loading" | "ready" | "error";

interface RadarState {
  status: RadarStatus;
  blips: RadarBlip[];
  proposals: RadarProposal[];
  lastScanAt: number | null;
  /** Phase 60: the Discovery Engine's last run. */
  lastDiscoveryAt: number | null;
  error: string | null;
  /** The blip whose panel is open. */
  selectedId: string | null;
  /** Radar chart or the accessible list. */
  view: "radar" | "list";

  load: () => Promise<void>;
  select: (id: string | null) => void;
  setView: (view: "radar" | "list") => void;
  /** Optimistic ring change (drag-and-drop or the panel's buttons); put back if refused. */
  move: (id: string, ring: RadarRing) => Promise<void>;
  add: (input: CreateBlipInput) => Promise<RadarBlip>;
  edit: (id: string, patch: UpdateBlipInput) => Promise<RadarBlip>;
  remove: (id: string) => Promise<void>;
  decide: (proposalId: string, decision: "apply" | "dismiss") => Promise<void>;
  scan: () => Promise<void>;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

type Api = typeof radarApi;

export function createRadarStore(api: Api = radarApi) {
  return create<RadarState>((set, get) => {
    const replaceBlip = (blip: RadarBlip) =>
      set((s) => ({ blips: s.blips.map((b) => (b.id === blip.id ? blip : b)) }));
    return {
      status: "idle",
      blips: [],
      proposals: [],
      lastScanAt: null,
      lastDiscoveryAt: null,
      error: null,
      selectedId: null,
      view: "radar",

      async load() {
        set((s) => ({ status: s.status === "ready" ? "ready" : "loading", error: null }));
        try {
          const snapshot = await api.snapshot();
          // An API from before Phase 60 has no `lastDiscoveryAt`.
          set({ ...snapshot, lastDiscoveryAt: snapshot.lastDiscoveryAt ?? null, status: "ready" });
        } catch (err) {
          set({ status: "error", error: errorText(err, "Couldn't load the radar.") });
        }
      },

      select: (selectedId) => set({ selectedId }),
      setView: (view) => set({ view }),

      async move(id, ring) {
        const before = get().blips.find((b) => b.id === id);
        if (!before || before.ring === ring) return;
        replaceBlip({ ...before, ring, previousRing: before.ring, movedAt: Date.now() });
        try {
          replaceBlip(await api.update(id, { ring }));
        } catch (err) {
          replaceBlip(before);
          throw new Error(errorText(err, "Couldn't move it."));
        }
      },

      async add(input) {
        const blip = await api.create(input);
        set((s) => ({ blips: [...s.blips.filter((b) => b.id !== blip.id), blip] }));
        return blip;
      },

      async edit(id, patch) {
        const blip = await api.update(id, patch);
        replaceBlip(blip);
        return blip;
      },

      async remove(id) {
        await api.remove(id);
        set((s) => ({
          blips: s.blips.filter((b) => b.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        }));
      },

      async decide(proposalId, decision) {
        let blip: RadarBlip | null = null;
        if (decision === "apply") blip = (await api.apply(proposalId)).blip;
        else await api.dismiss(proposalId);
        set((s) => ({ proposals: s.proposals.filter((p) => p.id !== proposalId) }));
        if (blip) {
          const added = blip;
          set((s) => ({ blips: [...s.blips.filter((b) => b.id !== added.id), added] }));
        }
      },

      async scan() {
        await api.scan();
      },
    };
  });
}

export const useRadar = createRadarStore();
