import type {
  CreateBlipInput,
  RadarBlip,
  RadarProposal,
  RadarSnapshot,
  UpdateBlipInput,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

/** AI Tech Radar (Phase 56), on the same HTTP API and auth as the Task Manager. */
export const radarApi = {
  snapshot: () => request<RadarSnapshot>("GET", "/radar"),
  create: (input: CreateBlipInput) =>
    request<{ blip: RadarBlip }>("POST", "/radar/blips", input).then((r) => r.blip),
  update: (id: string, patch: UpdateBlipInput) =>
    request<{ blip: RadarBlip }>("PUT", `/radar/blips/${encodeURIComponent(id)}`, patch).then(
      (r) => r.blip,
    ),
  remove: (id: string) =>
    request<{ deleted: string }>("DELETE", `/radar/blips/${encodeURIComponent(id)}`),
  apply: (proposalId: string) =>
    request<{ proposal: RadarProposal; blip: RadarBlip | null }>(
      "POST",
      `/radar/proposals/${encodeURIComponent(proposalId)}/apply`,
    ),
  dismiss: (proposalId: string) =>
    request<{ proposal: RadarProposal }>(
      "POST",
      `/radar/proposals/${encodeURIComponent(proposalId)}/dismiss`,
    ),
  scan: () => request<{ started: boolean }>("POST", "/radar/scan"),
};
