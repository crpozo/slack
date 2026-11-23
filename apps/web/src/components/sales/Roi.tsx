import {
  ROI_FORMULAS,
  roiDeck,
  RoiInputsSchema,
  roiModel,
  salesMoney,
  type RoiInputs,
  type SalesAccount,
  type SalesInput,
  type SalesOpportunity,
} from "@mindfultech/shared";
import { useMemo, useState } from "react";
import { useChat } from "../../store";
import { useSales } from "../../store/sales";
import { Modal, SecondaryButton } from "../Modal";
import { SlidesEditor } from "./Result";
import { DemoTag } from "./ui";

// ---------------------------------------------------------------------------
// Ventas (Phase 73): an opportunity's business case. Every assumption is
// editable; the numbers are computed by `roiModel` (shared, tested) as they
// change, and the decision deck is built from that same model, so a figure on
// a slide is the figure in the table.
// ---------------------------------------------------------------------------

const EMPTY: RoiInputs = {
  currency: "USD",
  horizonMonths: 24,
  investment: 0,
  recurringMonthly: 0,
  currentMonthlyCost: 0,
  benefits: [{ name: "Ahorro o ingreso adicional", monthly: 0 }],
  rampMonths: 3,
  scenarios: { conservador: 0.6, base: 1, optimista: 1.25 },
};

function Num({
  label,
  value,
  onChange,
  suffix,
}: Readonly<{ label: string; value: number; onChange: (n: number) => void; suffix?: string }>) {
  return (
    <label className="block text-xs font-medium text-ink-secondary">
      {label}
      <span className="mt-0.5 flex items-center gap-1">
        <input
          inputMode="decimal"
          value={Number.isFinite(value) ? String(value) : ""}
          onChange={(e) => onChange(Number(e.target.value.replace(",", ".")) || 0)}
          className="input w-full text-right tabular-nums"
        />
        {suffix && <span className="shrink-0 text-xs">{suffix}</span>}
      </span>
    </label>
  );
}

export function RoiModal({
  opportunity,
  account,
  onClose,
}: Readonly<{ opportunity: SalesOpportunity; account: SalesAccount; onClose: () => void }>) {
  const save = useSales((s) => s.save);
  const showToast = useChat((s) => s.showToast);
  const [inputs, setInputs] = useState<RoiInputs>(
    () =>
      opportunity.roi ?? {
        ...EMPTY,
        currency: opportunity.currency,
        investment: opportunity.amount,
      },
  );
  const [deck, setDeck] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = RoiInputsSchema.safeParse(inputs).success;
  const model = useMemo(() => (valid ? roiModel(inputs) : null), [inputs, valid]);
  const $ = (n: number) => salesMoney(n, inputs.currency);
  const patch = (change: Partial<RoiInputs>) => {
    setInputs((i) => ({ ...i, ...change }));
    setDeck(false);
  };
  const benefit = (i: number, change: Partial<RoiInputs["benefits"][number]>) =>
    patch({ benefits: inputs.benefits.map((b, at) => (at === i ? { ...b, ...change } : b)) });
  const dirty = JSON.stringify(inputs) !== JSON.stringify(opportunity.roi ?? null);

  async function persist() {
    setBusy(true);
    try {
      await save({ ...opportunity, roi: inputs } as SalesInput);
      showToast("Caso de negocio guardado en la oportunidad", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar.", "error");
    }
    setBusy(false);
  }

  return (
    <Modal
      title={`Caso de negocio · ${opportunity.name}`}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cerrar</SecondaryButton>
          <button
            type="button"
            className="btn-primary"
            disabled={!valid || busy || !dirty}
            onClick={() => void persist()}
          >
            {busy ? "Guardando…" : dirty ? "Guardar supuestos" : "Guardado"}
          </button>
        </>
      }
    >
      <div className="space-y-4" data-sales-roi>
        {opportunity.demo && <DemoTag />}
        <div>
          <p className="mb-1.5 text-sm font-semibold text-ink">Supuestos (editables)</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Num
              label="Inversión inicial"
              value={inputs.investment}
              onChange={(n) => patch({ investment: n })}
            />
            <Num
              label="Costo recurrente al mes"
              value={inputs.recurringMonthly}
              onChange={(n) => patch({ recurringMonthly: n })}
            />
            <Num
              label="Costo actual al mes"
              value={inputs.currentMonthlyCost}
              onChange={(n) => patch({ currentMonthlyCost: n })}
            />
            <Num
              label="Horizonte"
              value={inputs.horizonMonths}
              onChange={(n) => patch({ horizonMonths: Math.round(n) })}
              suffix="meses"
            />
            <Num
              label="Adopción gradual"
              value={inputs.rampMonths}
              onChange={(n) => patch({ rampMonths: Math.round(n) })}
              suffix="meses"
            />
            <label className="block text-xs font-medium text-ink-secondary">
              Moneda
              <input
                value={inputs.currency}
                onChange={(e) => patch({ currency: e.target.value.toUpperCase().slice(0, 3) })}
                className="input mt-0.5 w-full"
              />
            </label>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-semibold text-ink">Beneficios mensuales</p>
          <ul className="space-y-1.5">
            {inputs.benefits.map((b, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  value={b.name}
                  onChange={(e) => benefit(i, { name: e.target.value })}
                  aria-label={`Beneficio ${i + 1}`}
                  className="input min-w-0 flex-1"
                />
                <input
                  inputMode="decimal"
                  value={String(b.monthly)}
                  onChange={(e) =>
                    benefit(i, { monthly: Number(e.target.value.replace(",", ".")) || 0 })
                  }
                  aria-label={`Monto mensual del beneficio ${i + 1}`}
                  className="input w-28 text-right tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => patch({ benefits: inputs.benefits.filter((_, at) => at !== i) })}
                  className="px-1 text-ink-secondary hover:text-error"
                  aria-label={`Quitar el beneficio ${i + 1}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-1.5 text-xs font-semibold text-primary"
            onClick={() =>
              patch({ benefits: [...inputs.benefits, { name: "Nuevo beneficio", monthly: 0 }] })
            }
          >
            + Agregar beneficio
          </button>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-semibold text-ink">
            Escenarios: parte del beneficio que se logra
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(["conservador", "base", "optimista"] as const).map((name) => (
              <Num
                key={name}
                label={name[0]!.toUpperCase() + name.slice(1)}
                value={Math.round(inputs.scenarios[name] * 100)}
                onChange={(n) => patch({ scenarios: { ...inputs.scenarios, [name]: n / 100 } })}
                suffix="%"
              />
            ))}
          </div>
        </div>

        {model ? (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm" aria-label="Resultados por escenario">
              <thead className="bg-surface-hover text-xs text-ink-secondary">
                <tr>
                  {["Escenario", "Beneficio", "Costo", "Neto", "ROI", "Recuperación"].map(
                    (h, i) => (
                      <th
                        key={h}
                        className={`px-2 py-1.5 font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(["conservador", "base", "optimista"] as const).map((name) => {
                  const s = model.scenarios[name];
                  return (
                    <tr key={name} data-roi-scenario={name}>
                      <td className="px-2 py-1.5 font-medium capitalize text-ink">{name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {$(s.totalBenefit)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {$(s.totalCost)}
                      </td>
                      <td
                        className={`px-2 py-1.5 text-right font-semibold tabular-nums ${s.net >= 0 ? "text-primary" : "text-error"}`}
                      >
                        {$(s.net)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {s.roiPct === null ? "—" : `${s.roiPct}%`}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                        {s.paybackMonth === null ? "Fuera del horizonte" : `Mes ${s.paybackMonth}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-warning">Revisa los supuestos: hay un valor fuera de rango.</p>
        )}
        <details className="text-xs text-ink-secondary">
          <summary className="cursor-pointer font-semibold">Fórmulas</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {ROI_FORMULAS.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>

        {model &&
          (deck ? (
            <SlidesEditor
              name={`Caso de negocio ${account.name}`}
              initial={roiDeck(account, opportunity, model)}
            />
          ) : (
            <button type="button" className="btn-primary" onClick={() => setDeck(true)}>
              Convertir en presentación de decisión
            </button>
          ))}
      </div>
    </Modal>
  );
}
