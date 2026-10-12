import { useEffect, useRef, useState } from "react";
import {
  mediaErrorText,
  openCameraPreview,
  queryCameraPermission,
  stopStream,
  type CameraPermission,
} from "../lib/media";
import { VideoOffIcon } from "./icons";
import { StreamMedia } from "./StreamMedia";

/** Camera permission, kept current if the user grants or blocks it meanwhile. */
function useCameraPermission(): CameraPermission | null {
  const [state, setState] = useState<CameraPermission | null>(null);
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => status && setState(status.state);
    void queryCameraPermission().then((result) => {
      if (cancelled) return;
      status = result.status;
      setState(result.state);
      status?.addEventListener("change", onChange);
    });
    return () => {
      cancelled = true;
      status?.removeEventListener("change", onChange);
    };
  }, []);
  return state;
}

/** Whether `ref`'s element is on screen (inside the modal's scroll area) and the tab is visible. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting), {
      threshold: 0.25,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return inView && pageVisible;
}

/**
 * Live, mirrored preview of the selected camera for the Settings modal.
 *
 * Privacy: the camera is only open while the preview is actually visible.
 * Every track is stopped (camera light off) as soon as the modal closes
 * (unmount), the section scrolls out of view, the browser tab is hidden, or
 * another camera is picked. A stream that arrives after any of those is
 * stopped on arrival. It starts by itself only if camera access was already
 * granted; otherwise the user asks for it, so opening Settings never prompts.
 */
export function CameraPreview({ deviceId }: Readonly<{ deviceId: string }>) {
  const frame = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(frame);
  const permission = useCameraPermission();
  const [requested, setRequested] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowed = permission === "granted" || requested;
  const active = visible && allowed && permission !== "denied";

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let opened: MediaStream | null = null;
    setError(null);
    openCameraPreview(deviceId).then(
      (s) => {
        if (cancelled) {
          stopStream(s); // closed or hidden while the camera was starting
          return;
        }
        opened = s;
        setStream(s);
      },
      (err: unknown) => {
        if (!cancelled) setError(mediaErrorText(err, "camera"));
      },
    );
    return () => {
      cancelled = true;
      stopStream(opened);
      setStream(null);
    };
  }, [active, deviceId]);

  let overlay: React.ReactNode = null;
  if (permission === "denied") {
    overlay = "Camera access is blocked for this site. Allow it in the browser's site settings.";
  } else if (error) {
    overlay = error;
  } else if (permission !== null && !allowed) {
    overlay = (
      <button
        type="button"
        onClick={() => setRequested(true)}
        className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/25"
      >
        Show camera preview
      </button>
    );
  } else if (active && !stream) {
    overlay = "Starting camera…";
  }

  return (
    <div
      ref={frame}
      className="relative aspect-video w-full max-w-xs overflow-hidden rounded-xl border border-line bg-[#0E0D12]"
    >
      {stream && (
        <StreamMedia
          kind="video"
          stream={stream}
          muted
          label="Camera preview"
          className="h-full w-full -scale-x-100 object-cover"
        />
      )}
      {stream && (
        <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-error" aria-hidden="true" />
          <span>Camera on</span>
        </span>
      )}
      {overlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-white/75">
          {typeof overlay === "string" && <VideoOffIcon className="text-xl" />}
          {overlay}
        </div>
      )}
    </div>
  );
}
