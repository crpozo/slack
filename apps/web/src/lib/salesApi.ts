import type {
  SalesAiInput,
  SalesArtifact,
  SalesChange,
  SalesInput,
  SalesLead,
  SalesRecord,
  SalesState,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

/** Ventas (Phase 73). The server decides what each person sees. */
export const salesApi = {
  state: () => request<SalesState>("GET", "/sales"),
  save: (record: SalesInput) =>
    request<{ record: SalesRecord; changes: SalesChange[] }>(
      "PUT",
      `/sales/records/${encodeURIComponent(record.id)}`,
      record,
    ),
  remove: (id: string) =>
    request<{ deleted: string[] }>("DELETE", `/sales/records/${encodeURIComponent(id)}`),
  ask: (input: SalesAiInput) =>
    request<{ artifact: SalesArtifact }>("POST", "/sales/ai", input).then((r) => r.artifact),
  /** The confirmed CRM changes; the same `key` again applies nothing twice. */
  applyCrm: (key: string, updates: Array<{ recordId: string; field: string; value: string }>) =>
    request<{
      applied: Array<{ recordId: string; field: string; from: string; to: string }>;
      repeated: boolean;
    }>("POST", "/sales/crm/apply", { key, updates }),
  importLeads: (leads: Array<Omit<SalesLead, "fit">>) =>
    request<{ added: SalesRecord[]; skipped: Array<{ company: string; accountId: string }> }>(
      "POST",
      "/sales/import",
      { leads },
    ),
  resetDemo: () => request<SalesState>("POST", "/sales/demo/reset"),
  /** Takes the demo's fictitious rows away (nothing else). */
  clearDemo: () => request<SalesState>("POST", "/sales/demo/reset", { clear: true }),
};
