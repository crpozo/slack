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
    notes: { on: false, changedBy: null, keepAudio: false, unavailable: null },
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
      sharing: false,
      sharingFromWindow: false,
      canShare: true,
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
    const api = {
      toggleMic: vi.fn(),
      toggleCamera: vi.fn(async () => {}),
      hangUp: vi.fn(),
      shareScreenTrack: vi.fn(async () => {}),
      stopSharing: vi.fn(async () => {}),
    };
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

  it("shares the screen the small window captured, and stops sharing on its word", async () => {
    const api = {
      toggleMic: vi.fn(),
      toggleCamera: vi.fn(async () => {}),
      hangUp: vi.fn(),
      shareScreenTrack: vi.fn(async () => {}),
      stopSharing: vi.fn(async () => {}),
    };
    const focus = vi.fn(async () => {});
    const track = { kind: "video" } as MediaStreamTrack;
    await runPipCommand(
      "share-start",
      api,
      focus,
      () => {},
      () => track,
    );
    expect(api.shareScreenTrack).toHaveBeenCalledWith(track);
    // Nothing has arrived over the loopback yet: nothing to share.
    await runPipCommand(
      "share-start",
      api,
      focus,
      () => {},
      () => null,
    );
    expect(api.shareScreenTrack).toHaveBeenCalledTimes(1);
    await runPipCommand("share-stop", api, focus);
    expect(api.stopSharing).toHaveBeenCalledTimes(1);
  });

  it("tells the small window whether you're sharing, and whether it's its own capture", () => {
    const fromWindow = { kind: "video" } as MediaStreamTrack;
    const elsewhere = { kind: "video" } as MediaStreamTrack;
    const sharing = (track: MediaStreamTrack) =>
      call({
        sharing: true,
        localScreen: { getVideoTracks: () => [track] } as unknown as MediaStream,
      });
    expect(pipStateOf(sharing(fromWindow), "Ana", fromWindow)).toMatchObject({
      sharing: true,
      sharingFromWindow: true,
    });
    expect(pipStateOf(sharing(elsewhere), "Ana", fromWindow)).toMatchObject({
      sharing: true,
      sharingFromWindow: false,
    });
    expect(pipStateOf(call(), "Ana", fromWindow).sharingFromWindow).toBe(false);
    // Only a connected call with a screen transceiver can share.
    expect(pipStateOf(call({ phase: "connecting" }), "Ana").canShare).toBe(false);
    expect(pipStateOf(call({ canShare: false }), "Ana").canShare).toBe(false);
  });
});
