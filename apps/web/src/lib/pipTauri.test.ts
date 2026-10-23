import { describe, expect, it, vi } from "vitest";
import type { CallView } from "./call";
import { pipStateOf, runPipCommand } from "./pipTauri";

const call = (patch: Partial<CallView> = {}): CallView =>
  ({
    callId: "c1",
    channelId: "dm_a_b",
    peerId: "u-b",
    media: "video",
    phase: "connected",
    micOn: true,
    camOn: false,
    sharing: false,
    localCamera: null,
    localScreen: null,
    remoteStream: {} as MediaStream,
    remoteScreen: {} as MediaStream,
    canShare: true,
    peer: { micOn: false, camOn: true, sharing: true },
    connectedAt: 5,
    micDeviceId: null,
    cameraDeviceId: null,
    notes: {
      on: false,
      changedBy: null,
      local: { kind: "off" },
      onDevice: false,
      phrases: 0,
      full: false,
    },
    reconnecting: null,
    ...patch,
  }) as CallView;

describe("the desktop call window's bridge", () => {
  it("reduces the call to what the small window shows, with peer flags only once connected", () => {
    expect(pipStateOf(call(), "Ana")).toEqual({
      name: "Ana",
      media: "video",
      phase: "connected",
      connectedAt: 5,
      micOn: true,
      camOn: false,
      peerMicOn: false,
      peerCamOn: true,
      peerSharing: true,
      notesOn: false,
      reconnectingUntil: null,
    });
    // Phase 34: the small window counts down too.
    expect(
      pipStateOf(call({ reconnecting: { since: 1_000, deadline: 31_000 } }), "Ana")
        .reconnectingUntil,
    ).toBe(31_000);
    expect(pipStateOf(call({ phase: "connecting", connectedAt: null }), "Ana")).toMatchObject({
      phase: "connecting",
      peerCamOn: false,
      peerSharing: false,
    });
    expect(pipStateOf(call({ remoteStream: null }), "Ana").peerCamOn).toBe(false);
  });

  it("runs the small window's buttons against the call, and focus against the main window", async () => {
    const api = { toggleMic: vi.fn(), toggleCamera: vi.fn(async () => {}), hangUp: vi.fn() };
    const focus = vi.fn(async () => {});
    runPipCommand("mic", api, focus);
    await runPipCommand("camera", api, focus);
    runPipCommand("hangup", api, focus);
    await runPipCommand("focus", api, focus);
    const close = vi.fn();
    await runPipCommand("close", api, focus, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.toggleMic).toHaveBeenCalledTimes(1);
    expect(api.toggleCamera).toHaveBeenCalledTimes(1);
    expect(api.hangUp).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
