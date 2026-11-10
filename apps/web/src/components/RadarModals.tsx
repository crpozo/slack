import {
  CreateBlipSchema,
  MAX_BLIP_DESCRIPTION,
  MAX_BLIP_NAME,
  RADAR_QUADRANTS,
  RADAR_RINGS,
  RING_MEANING,
  type RadarBlip,
  type RadarQuadrant,
  type RadarRing,
} from "@mindfultech/shared";
import { useState, type FormEvent } from "react";
import { useRadar } from "../store/radar";
import { Modal, SecondaryButton } from "./Modal";

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * Add a technology, or edit one (admins). The optional "Model ID" is kept as
 * `meta.modelId`: Phase 2's LLM-Stats dashboard keys live statistics off it.
 */
export function BlipModal({
  blip,
  onClose,
  onSaved,
}: Readonly<{ blip?: RadarBlip; onClose: () => void; onSaved: (blip: RadarBlip) => void }>) {
  const add = useRadar((s) => s.add);
  const edit = useRadar((s) => s.edit);
  const [name, setName] = useState(blip?.name ?? "");
  const [quadrant, setQuadrant] = useState<RadarQuadrant>(blip?.quadrant ?? "Models");
  const [ring, setRing] = useState<RadarRing>(blip?.ring ?? "Assess");
  const [description, setDescription] = useState(blip?.description ?? "");
  const [link, setLink] = useState(blip?.link ?? "");
  const [modelId, setModelId] = useState(blip?.meta?.modelId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const meta = () => {
    const rest = { ...(blip?.meta ?? {}) };
    delete rest.modelId;
    return modelId.trim() && quadrant === "Models" ? { ...rest, modelId: modelId.trim() } : rest;
  };
  const input = { name, quadrant, ring, description, link, meta: meta() };
  const valid = CreateBlipSchema.safeParse(input).success;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(blip ? await edit(blip.id, input) : await add(input));
    } catch (err) {
      setError(errorText(err, "Couldn't save it."));
      setBusy(false);
    }
  }

  const field = "input bg-surface";
  return (
    <Modal
      title={blip ? `Edit ${blip.name}` : "Add a technology"}
      width="md"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="submit" form="blip-form" className="btn-primary" disabled={!valid || busy}>
            {busy ? "Saving…" : blip ? "Save" : "Add to radar"}
          </button>
        </>
      }
    >
      <form id="blip-form" onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="blip-name" className="text-sm font-medium text-ink">
            Name
          </label>
          <input
            id="blip-name"
            className={field}
            value={name}
            maxLength={MAX_BLIP_NAME}
            placeholder="e.g. LangGraph"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="blip-quadrant" className="text-sm font-medium text-ink">
              Quadrant
            </label>
            <select
              id="blip-quadrant"
              className={field}
              value={quadrant}
              onChange={(e) => setQuadrant(e.target.value as RadarQuadrant)}
              disabled={busy}
            >
              {RADAR_QUADRANTS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="blip-ring" className="text-sm font-medium text-ink">
              Ring
            </label>
            <select
              id="blip-ring"
              className={field}
              value={ring}
              onChange={(e) => setRing(e.target.value as RadarRing)}
              disabled={busy}
            >
              {RADAR_RINGS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-secondary">{RING_MEANING[ring]}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="blip-description" className="text-sm font-medium text-ink">
            Our stance
          </label>
          <textarea
            id="blip-description"
            className={`${field} min-h-[6rem] resize-y`}
            value={description}
            maxLength={MAX_BLIP_DESCRIPTION}
            placeholder="Why it sits in this ring, in a sentence or two."
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
          <p className="text-right text-xs tabular-nums text-ink-secondary">
            {description.length}/{MAX_BLIP_DESCRIPTION}
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="blip-link" className="text-sm font-medium text-ink">
            Link <span className="font-normal text-ink-secondary">(optional, https)</span>
          </label>
          <input
            id="blip-link"
            className={field}
            value={link}
            placeholder="https://…"
            onChange={(e) => setLink(e.target.value)}
            disabled={busy}
          />
        </div>
        {quadrant === "Models" && (
          <div className="space-y-1.5">
            <label htmlFor="blip-model-id" className="text-sm font-medium text-ink">
              Model ID <span className="font-normal text-ink-secondary">(optional)</span>
            </label>
            <input
              id="blip-model-id"
              className={`${field} font-mono`}
              value={modelId}
              placeholder="e.g. anthropic.claude-haiku-5-5"
              onChange={(e) => setModelId(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-ink-secondary">
              The API identifier; the LLM-Stats dashboard (next phase) links live figures to it.
            </p>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
