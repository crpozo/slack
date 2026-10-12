import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endNotice, parsePeerState } from "./call";
import { loadMediaPrefs, mediaConstraints, mediaErrorText, saveMediaPrefs } from "./media";

describe("media preferences", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the chosen devices and defaults to the system ones", () => {
    expect(loadMediaPrefs()).toEqual({ audioInputId: "", videoInputId: "" });
    saveMediaPrefs({ audioInputId: "mic-2", videoInputId: "cam-1" });
    expect(loadMediaPrefs()).toEqual({ audioInputId: "mic-2", videoInputId: "cam-1" });
  });

  it("ignores corrupt or foreign values", () => {
    store["slack.mediaDevices"] = "{not json";
    expect(loadMediaPrefs()).toEqual({ audioInputId: "", videoInputId: "" });
    store["slack.mediaDevices"] = JSON.stringify({ audioInputId: 7, videoInputId: "cam" });
    expect(loadMediaPrefs()).toEqual({ audioInputId: "", videoInputId: "cam" });
  });

  it("requests exactly the saved devices, and only the kinds the call needs", () => {
    const prefs = { audioInputId: "mic-2", videoInputId: "cam-1" };
    const both = mediaConstraints({ audio: true, video: true }, prefs);
    expect(both.audio).toMatchObject({ deviceId: { exact: "mic-2" }, echoCancellation: true });
    expect(both.video).toMatchObject({ deviceId: { exact: "cam-1" }, width: { ideal: 1280 } });

    const voice = mediaConstraints({ audio: true, video: false }, prefs);
    expect(voice.video).toBe(false);

    const defaults = mediaConstraints(
      { audio: true, video: true },
      {
        audioInputId: "",
        videoInputId: "",
      },
    );
    expect(defaults.audio).not.toHaveProperty("deviceId");
    expect(defaults.video).not.toHaveProperty("deviceId");
  });

  it("explains media errors in plain words", () => {
    const denied = new DOMException("x", "NotAllowedError");
    expect(mediaErrorText(denied, "camera")).toMatch(/Permission to use your camera was denied/);
    expect(mediaErrorText(new DOMException("x", "NotFoundError"), "microphone")).toBe(
      "No microphone was found.",
    );
    expect(mediaErrorText(new Error("?"), "screen")).toBe("Couldn't access your screen.");
  });
});

describe("call notices", () => {
  it("describe how the other side ended the call", () => {
    expect(endNotice("declined", "Bob", "outgoing")).toBe("Bob declined the call.");
    expect(endNotice("busy", "Bob", "outgoing")).toBe("Bob is on another call.");
    expect(endNotice("unavailable", "Bob", "outgoing")).toBe("Bob isn't online right now.");
    expect(endNotice("no_answer", "Bob", "outgoing")).toBe("Bob didn't answer.");
    expect(endNotice("failed", "Bob", "connected")).toBe("The call with Bob was lost.");
  });

  it("report a missed call when the caller gives up while it rings", () => {
    expect(endNotice("cancelled", "Ann", "incoming")).toBe("Missed call from Ann.");
    expect(endNotice("no_answer", "Ann", "incoming")).toBe("Missed call from Ann.");
  });

  it("stay quiet on a normal hang-up", () => {
    expect(endNotice("hangup", "Bob", "connected")).toBeNull();
    expect(endNotice("cancelled", "Bob", "connecting")).toBeNull();
  });
});

describe("peer media state", () => {
  it("accepts well-formed state messages only", () => {
    expect(parsePeerState('{"micOn":false,"camOn":true,"sharing":false}')).toEqual({
      micOn: false,
      camOn: true,
      sharing: false,
    });
    expect(parsePeerState('{"micOn":"no","camOn":true,"sharing":false}')).toBeNull();
    expect(parsePeerState("not json")).toBeNull();
    expect(parsePeerState(new ArrayBuffer(4))).toBeNull();
    expect(
      parsePeerState(`{"micOn":true,"camOn":true,"sharing":false,"x":"${"a".repeat(300)}"}`),
    ).toBeNull();
  });
});
