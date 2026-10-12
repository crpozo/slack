import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Enough of an AudioContext to count what gets scheduled. */
class FakeNode {
  gain = {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  frequency = { value: 0 };
  type = "sine";
  connect = vi.fn(() => this);
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeFails = false;
  state = "suspended";
  currentTime = 0;
  destination = {};
  oscillators: FakeNode[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const node = new FakeNode();
    this.oscillators.push(node);
    return node;
  }
  createGain() {
    return new FakeNode();
  }
  async resume() {
    if (FakeAudioContext.resumeFails) throw new DOMException("blocked", "NotAllowedError");
    this.state = "running";
  }
}

let store: Record<string, string>;
let sounds: typeof import("./sounds");

const flush = () => vi.advanceTimersByTimeAsync(0);
const started = () => FakeAudioContext.instances.flatMap((c) => c.oscillators).length;

beforeEach(async () => {
  vi.useFakeTimers();
  store = {};
  FakeAudioContext.instances = [];
  FakeAudioContext.resumeFails = false;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.resetModules();
  sounds = await import("./sounds"); // fresh module state per test
});

afterEach(() => {
  sounds.stopRinging();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("preference", () => {
  it("is on by default and remembered", () => {
    expect(sounds.soundsEnabled()).toBe(true);
    sounds.setSoundsEnabled(false);
    expect(store["slack.sounds"]).toBe("off");
    expect(sounds.soundsEnabled()).toBe(false);
    sounds.setSoundsEnabled(true);
    expect(sounds.soundsEnabled()).toBe(true);
  });

  it("notifies listeners and stops a ring when muted", async () => {
    const listener = vi.fn();
    sounds.onSoundsChange(listener);
    sounds.startRinging("incoming");
    expect(sounds.currentRing()).toBe("incoming");

    sounds.setSoundsEnabled(false);
    expect(listener).toHaveBeenCalledWith(false);
    expect(sounds.currentRing()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toBe(0); // nothing scheduled after muting
  });
});

describe("rings", () => {
  it("outgoing loops a soft tone every 3 s until stopped", async () => {
    sounds.startRinging("outgoing");
    await flush();
    expect(started()).toBe(2); // first cycle right away (two detuned oscillators)
    await vi.advanceTimersByTimeAsync(3000);
    expect(started()).toBe(4);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started()).toBe(6);

    sounds.stopRinging();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toBe(6);
    expect(sounds.currentRing()).toBeNull();
  });

  it("incoming is a different, repeated pattern", async () => {
    sounds.startRinging("incoming");
    await flush();
    expect(started()).toBe(4);
    const frequencies = FakeAudioContext.instances[0]!.oscillators.map((o) => o.frequency.value);
    expect(frequencies).toEqual([880, 660, 880, 660]);
  });

  it("switching kinds replaces the loop; the same kind is a no-op", async () => {
    sounds.startRinging("outgoing");
    await flush();
    sounds.startRinging("outgoing");
    await flush();
    expect(started()).toBe(2);

    sounds.startRinging("incoming");
    await flush();
    expect(sounds.currentRing()).toBe("incoming");
    expect(started()).toBe(6);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started()).toBe(10); // only the incoming loop is running
  });

  it("stays silent and never throws when autoplay is blocked", async () => {
    FakeAudioContext.resumeFails = true;
    expect(() => sounds.startRinging("incoming")).not.toThrow();
    await vi.advanceTimersByTimeAsync(7000);
    expect(started()).toBe(0);
    expect(sounds.currentRing()).toBe("incoming"); // still "ringing" visually, just unheard
    sounds.stopRinging();
  });

  it("stays silent where Web Audio does not exist", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => sounds.startRinging("incoming")).not.toThrow();
    expect(() => sounds.playMessageSound()).not.toThrow();
  });
});

describe("message pop", () => {
  it("plays two short notes once", async () => {
    sounds.playMessageSound();
    await flush();
    expect(started()).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(started()).toBe(2);
  });

  it("is muted by the preference", async () => {
    sounds.setSoundsEnabled(false);
    sounds.playMessageSound();
    await flush();
    expect(started()).toBe(0);
  });
});

describe("autoplay unlock", () => {
  it("resumes the context on the first gesture, then stops listening", async () => {
    const target = new EventTarget();
    sounds.installAudioUnlock(target);
    target.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(FakeAudioContext.instances[0]?.state).toBe("running");

    const before = FakeAudioContext.instances.length;
    target.dispatchEvent(new Event("keydown"));
    await flush();
    expect(FakeAudioContext.instances.length).toBe(before); // listener removed, no new work
  });

  it("keeps listening while the browser still blocks audio", async () => {
    FakeAudioContext.resumeFails = true;
    const target = new EventTarget();
    sounds.installAudioUnlock(target);
    target.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(FakeAudioContext.instances[0]?.state).toBe("suspended");

    FakeAudioContext.resumeFails = false;
    target.dispatchEvent(new Event("keydown"));
    await flush();
    expect(FakeAudioContext.instances[0]?.state).toBe("running");
  });
});
