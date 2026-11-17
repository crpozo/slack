import { canManageVaultSecret, type VaultSecret } from "@mindfultech/shared";
import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { useVault } from "../store/vault";
import { Modal, SecondaryButton } from "./Modal";
import { PinPrompt } from "./VaultPin";
import { SearchIcon } from "./icons";

/**
 * Phase 68: tags a saved Vault secret in this conversation. Pick one of
 * yours; its members get access and a card posted here opens it in one tap.
 * Asks for the Vault PIN first when the Vault is locked.
 */
export function VaultTagPicker({
  channelId,
  onClose,
}: Readonly<{ channelId: string; onClose: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const token = useVault((s) => s.openToken());
  const { secrets, status, load, put } = useVault();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (token && status !== "ready" && status !== "loading") void load();
  }, [token, status, load]);

  const mine = useMemo(() => {
    const q = query.trim().toLowerCase();
    return secrets
      .filter((s) => me && canManageVaultSecret(s, me.userId, me.role))
      .filter(
        (s) => !q || `${s.name} ${s.username ?? ""} ${s.website ?? ""}`.toLowerCase().includes(q),
      );
  }, [secrets, me, query]);

  if (!token) {
    return (
      <PinPrompt
        title="Abrir el Vault"
        onClose={onClose}
        onSubmit={async (pin) => {
          await useVault.getState().unlocked(await vaultApi.unlock(pin));
        }}
      />
    );
  }

  async function tag(secret: VaultSecret) {
    if (!token) return;
    setBusy(secret.secretId);
    try {
      put(await vaultApi.share(secret.secretId, channelId, token));
      showToast(
        `"${secret.name}" compartido aquí: los miembros pueden abrirlo desde la tarjeta.`,
        "success",
      );
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo compartir.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Compartir del Vault"
      width="md"
      onClose={onClose}
      footer={<SecondaryButton onClick={onClose}>Cancelar</SecondaryButton>}
    >
      <div className="space-y-3" data-vault-tag-picker>
        <p className="text-sm text-ink-secondary">
          Elige una credencial: los miembros de este chat podrán abrirla desde la tarjeta que se
          publica aquí (con su PIN del Vault).
        </p>
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-primary">
          <SearchIcon className="shrink-0 text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar credencial"
            aria-label="Buscar credencial"
            className="w-full bg-transparent py-2 text-sm text-ink focus:outline-none"
          />
        </label>
        {status === "loading" && <p className="text-sm text-ink-secondary">Cargando…</p>}
        {status === "ready" && mine.length === 0 && (
          <p className="text-sm text-ink-secondary">
            {query ? "Ninguna coincide." : "No tienes credenciales en el Vault todavía."}
          </p>
        )}
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {mine.map((s) => (
            <li key={s.secretId}>
              <button
                type="button"
                onClick={() => void tag(s)}
                disabled={busy !== null}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-hover disabled:opacity-60"
              >
                <KeyRound size={18} className="shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{s.name}</span>
                  <span className="block truncate text-xs text-ink-secondary">
                    {s.username || s.website || "Sin usuario"}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-primary">
                  {busy === s.secretId ? "Compartiendo…" : "Compartir"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
