import { useEffect, useState } from "react";
import { dragPipWindow, startPipPage, type PipCallState } from "../lib/pipTauri";
import { applyTheme } from "../lib/theme";
import { PipCallView } from "./PipCallView";

/**
 * The desktop app's small always-on-top call window (`/call/pip`). It has no
 * session of its own: the main window streams the peer's video to it and
 * tells it the call's state; its buttons go back as commands. Nothing to
 * show until the main window speaks.
 */
export function CallPipPage() {
  const [state, setState] = useState<PipCallState | null>(null);
  const [streams, setStreams] = useState<{
    camera: MediaStream | null;
    screen: MediaStream | null;
  }>({ camera: null, screen: null });
  const [bridge, setBridge] = useState<ReturnType<typeof startPipPage> | null>(null);

  useEffect(() => {
    applyTheme();
    const page = startPipPage({
      onState: setState,
      onStreams: setStreams,
      onBye: () => window.close(),
    });
    setBridge(page);
    return () => page.stop();
  }, []);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0E0D12] text-xs text-white/70">
        Connecting to the call…
      </div>
    );
  }
  return (
    <PipCallView
      {...state}
      camera={streams.camera}
      screen={streams.screen}
      onMic={() => bridge?.send("mic")}
      onCamera={() => bridge?.send("camera")}
      onHangUp={() => bridge?.send("hangup")}
      onBack={() => bridge?.send("focus")}
      onClose={() => bridge?.send("close")}
      onDragStart={dragPipWindow}
    />
  );
}
