import { useState, type ReactNode } from "react";
import {
  dismissInstallSuggestion,
  installPlatform,
  shouldSuggestInstall,
  type InstallPlatform,
} from "../lib/install";
import { CloseIcon, MoreHorizontalIcon, ShareIcon, SmartphoneIcon, SquarePlusIcon } from "./icons";
import { Modal, SecondaryButton } from "./Modal";

// ---------------------------------------------------------------------------
// Phase 56: how to keep MindfulTech as an app (Home Screen, Dock, taskbar).
// It's a web app: it installs from the browser, no App Store. In Spanish, as
// the team's phones show these menus.
// ---------------------------------------------------------------------------

const TABS: Array<{ id: InstallPlatform; label: string }> = [
  { id: "ios", label: "iPhone / iPad" },
  { id: "android", label: "Android" },
  { id: "desktop", label: "Computadora" },
];

/** An icon as it looks on the phone, inline in a step. */
function Key({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="mx-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-line bg-surface-hover px-1 align-middle text-ink">
      {children}
    </span>
  );
}

function Steps({ items }: Readonly<{ items: ReactNode[] }>) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span className="min-w-0 pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

const STEPS: Record<InstallPlatform, ReactNode[]> = {
  ios: [
    <>
      Abre <strong>slack.mindfultech.ec</strong> en <strong>Safari</strong> (en iOS 16.4 o posterior
      también sirve Chrome).
    </>,
    <>
      Toca <strong>Compartir</strong>{" "}
      <Key>
        <ShareIcon aria-label="Compartir" />
      </Key>
      : abajo en el iPhone, arriba a la derecha en el iPad. Si no lo ves, toca{" "}
      <Key>
        <MoreHorizontalIcon aria-label="Más" />
      </Key>{" "}
      y luego <strong>Compartir</strong>.
    </>,
    <>
      Baja y toca <strong>Agregar a inicio</strong>{" "}
      <Key>
        <SquarePlusIcon aria-hidden="true" />
      </Key>{" "}
      <span className="text-ink-secondary">(en inglés: “Add to Home Screen”)</span>.
    </>,
    <>
      Si aparece <strong>Abrir como app web</strong>, déjalo activado. Toca <strong>Agregar</strong>
      .
    </>,
    <>
      Abre la app desde el ícono nuevo en tu pantalla de inicio e inicia sesión una vez. Para
      recibir notificaciones, dentro de la app ve a <strong>Settings</strong> y activa{" "}
      <strong>Push notifications</strong>.
    </>,
  ],
  android: [
    <>
      Abre <strong>slack.mindfultech.ec</strong> en <strong>Chrome</strong>.
    </>,
    <>
      Toca el menú <Key>⋮</Key> arriba a la derecha.
    </>,
    <>
      Toca <strong>Instalar app</strong> (o <strong>Agregar a la pantalla principal</strong>) y
      confirma con <strong>Instalar</strong>.
    </>,
    <>
      Ábrela desde tu pantalla principal o el cajón de apps, e inicia sesión una vez. Para
      notificaciones: <strong>Settings</strong> → <strong>Push notifications</strong>.
    </>,
  ],
  desktop: [
    <>
      En <strong>Chrome</strong> o <strong>Edge</strong>: abre <strong>slack.mindfultech.ec</strong>{" "}
      y toca el ícono de instalar en la barra de direcciones (a la derecha), o el menú <Key>⋮</Key>{" "}
      → <strong>Transmitir, guardar y compartir</strong> → <strong>Instalar página como app</strong>
      .
    </>,
    <>
      En <strong>Safari</strong> (Mac): menú <strong>Archivo</strong> →{" "}
      <strong>Agregar al Dock</strong>.
    </>,
    <>Se abre en su propia ventana y queda en el Dock, el menú Inicio o la barra de tareas.</>,
  ],
};

/** The steps, for this device first; the other platforms one tap away. */
export function InstallGuideModal({ onClose }: Readonly<{ onClose: () => void }>) {
  const [tab, setTab] = useState<InstallPlatform>(installPlatform);
  return (
    <Modal
      title="Instalar como app"
      width="sm"
      onClose={onClose}
      footer={<SecondaryButton onClick={onClose}>Listo</SecondaryButton>}
    >
      <div className="space-y-4" data-install-guide>
        <p className="text-sm text-ink-secondary">
          Ten MindfulTech como una app más: con su ícono, a pantalla completa y con notificaciones.
          Se instala desde el navegador, sin App Store.
        </p>
        <div
          role="tablist"
          aria-label="Dispositivo"
          className="flex gap-1 rounded-lg bg-surface-hover p-1"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold ${
                tab === t.id ? "bg-surface text-ink shadow" : "text-ink-secondary hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          <Steps items={STEPS[tab]} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * On an iPhone or iPad in the browser (not yet installed): a card suggesting
 * the app, with the steps one tap away. "No, gracias" hides it for good.
 */
export function InstallBanner({ className = "" }: Readonly<{ className?: string }>) {
  const [show, setShow] = useState(shouldSuggestInstall);
  const [guide, setGuide] = useState(false);
  if (!show && !guide) return null;
  return (
    <>
      {show && (
        <div
          className={`flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5 ${className}`}
          role="note"
          data-install-banner
        >
          <SmartphoneIcon className="shrink-0 text-xl text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Instala MindfulTech como app</p>
            <p className="text-xs text-ink-secondary">
              Con su ícono y notificaciones en tu iPhone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setGuide(true)}
            className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
          >
            Ver cómo
          </button>
          <button
            type="button"
            onClick={() => {
              dismissInstallSuggestion();
              setShow(false);
            }}
            className="-mr-1 shrink-0 rounded-md p-1.5 text-ink-secondary hover:text-ink"
            aria-label="No, gracias"
            title="No, gracias"
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {guide && <InstallGuideModal onClose={() => setGuide(false)} />}
    </>
  );
}
