/** Preferred input devices for calls; empty means "system default". */
export interface MediaPrefs {
  audioInputId: string;
  videoInputId: string;
}

const STORAGE_KEY = "slack.mediaDevices";
const EMPTY: MediaPrefs = { audioInputId: "", videoInputId: "" };

export function loadMediaPrefs(): MediaPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...EMPTY };
    const { audioInputId, videoInputId } = raw as Record<string, unknown>;
    return {
      audioInputId: typeof audioInputId === "string" ? audioInputId : "",
      videoInputId: typeof videoInputId === "string" ? videoInputId : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveMediaPrefs(prefs: MediaPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (privacy mode): the choice lasts for this page only.
  }
}

/**
 * Constraint for one kind of input. A saved device is `exact` so the call uses
 * it; `getUserMedia` falls back to the default when that device is gone
 * (see `getUserMediaWithFallback`).
 */
function trackConstraint(deviceId: string, extra: MediaTrackConstraints = {}) {
  return deviceId ? { ...extra, deviceId: { exact: deviceId } } : { ...extra };
}

const VIDEO_SHAPE: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
const AUDIO_SHAPE: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };

/** `getUserMedia` constraints for a call, honoring the saved devices. */
export function mediaConstraints(
  want: { audio: boolean; video: boolean },
  prefs: MediaPrefs = loadMediaPrefs(),
): MediaStreamConstraints {
  return {
    audio: want.audio ? trackConstraint(prefs.audioInputId, AUDIO_SHAPE) : false,
    video: want.video ? trackConstraint(prefs.videoInputId, VIDEO_SHAPE) : false,
  };
}

/** Same constraints without the device ids, for when a saved device was unplugged. */
function withoutDevices(constraints: MediaStreamConstraints): MediaStreamConstraints {
  const strip = (c: MediaStreamConstraints["audio"]) => {
    if (typeof c !== "object") return c;
    const rest = { ...c };
    delete rest.deviceId;
    return rest;
  };
  return { audio: strip(constraints.audio), video: strip(constraints.video) };
}

/**
 * `getUserMedia` with the saved devices; if one of them is missing
 * (`OverconstrainedError` / `NotFoundError`), retries with the defaults.
 */
export async function getUserMediaWithFallback(want: {
  audio: boolean;
  video: boolean;
}): Promise<MediaStream> {
  const constraints = mediaConstraints(want);
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    return navigator.mediaDevices.getUserMedia(withoutDevices(constraints));
  }
}

/** User-facing message for a `getUserMedia` / `getDisplayMedia` failure. */
export function mediaErrorText(err: unknown, what: string): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `Permission to use your ${what} was denied. Allow it in the browser's site settings.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return `No ${what} was found.`;
  }
  if (name === "NotReadableError") return `Your ${what} is being used by another app.`;
  return `Couldn't access your ${what}.`;
}

export interface InputDevices {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  /** Labels are hidden until the site has been granted media access once. */
  labelled: boolean;
}

export async function listInputDevices(): Promise<InputDevices> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], cameras: [], labelled: false };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
  const cameras = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  return {
    microphones,
    cameras,
    labelled: [...microphones, ...cameras].some((d) => d.label),
  };
}

export const supportsCalls = () =>
  typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export const supportsScreenShare = () => !!navigator.mediaDevices?.getDisplayMedia;

/**
 * A single new track from exactly `deviceId` (no fallback: the user picked it),
 * e.g. to swap the microphone or camera in the middle of a call.
 */
export async function getDeviceTrack(
  kind: "audio" | "video",
  deviceId: string,
): Promise<MediaStreamTrack> {
  const constraints = mediaConstraints(
    { audio: kind === "audio", video: kind === "video" },
    { audioInputId: deviceId, videoInputId: deviceId },
  );
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const [track] = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
  if (!track) throw new DOMException("No track", "NotFoundError");
  return track;
}
