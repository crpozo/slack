import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  Transcriber,
  type RecognitionLike,
  type TranscriberState,
} from "./transcriber";

class FakeRecognition implements RecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  onspeechstart: RecognitionLike["onspeechstart"] = null;
  starts: Array<MediaStreamTrack | undefined> = [];
  stops = 0;
  aborts = 0;
  start(track?: MediaStreamTrack) {
    this.starts.push(track);
  }
  stop() {
    this.stops++;
  }
  abort() {
    this.aborts++;
  }
  /** The browser hands over results `from` onwards. */
  emit(results: Array<[string, boolean]>, from = 0) {
    const list = Object.assign(
      results.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal })),
      {},
    ) as unknown as Parameters<NonNullable<RecognitionLike["onresult"]>>[0]["results"];
    this.onresult?.({ resultIndex: from, results: list });
  }
}

function setup() {
  let clock = 1_000;
  const timers: Array<{ fn: () => void; at: number }> = [];
  const rec = new FakeRecognition();
  const phrases: Array<[string, number]> = [];
  const states: TranscriberState[] = [];
  const t = new Transcriber({
    create: () => rec,
    lang: "es-EC",
    onPhrase: (text, at) => phrases.push([text, at]),
    onState: (s) => states.push(s),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const i = timers.indexOf(timer as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of [...timers].filter((x) => x.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
  };
  return { t, rec, phrases, states, advance, timers, setClock: (c: number) => (clock = c) };
}

describe("Transcriber", () => {
  it("configures continuous recognition and emits finished phrases stamped with their start", () => {
    const { t, rec, phrases, states, advance } = setup();
    t.setWanted(true);
    expect(rec).toMatchObject({ lang: "es-EC", continuous: true, interimResults: true });
    expect(rec.starts).toHaveLength(1);
    expect(states.at(-1)).toEqual({ kind: "listening" });

    advance(500);
    rec.onspeechstart?.();
    advance(700);
    rec.emit([["hola a", false]]);
    advance(800);
    rec.emit([["  hola a todos  ", true]]);
    advance(100);
    rec.emit(
      [
        ["hola a todos", true],
        ["¿empezamos?", true],
      ],
      1,
    );
    expect(phrases).toEqual([
      ["hola a todos", 1_500],
      ["¿empezamos?", 3_100],
    ]);
  });

  it("restarts at once after a healthy session, and backs off after sessions that die young", () => {
    const { t, rec, advance } = setup();
    t.setWanted(true);
    advance(30_000);
    rec.onend?.(); // Chrome ended a long, healthy session
    advance(0);
    expect(rec.starts).toHaveLength(2);

    // Now it keeps dying at once: 250 ms, 500 ms, 1 s… up to 10 s.
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      advance(10);
      rec.onend?.();
      const before = rec.starts.length;
      let waited = 0;
      while (rec.starts.length === before) {
        advance(50);
        waited += 50;
      }
      delays.push(waited);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
    expect(delays.at(-1)).toBeLessThanOrEqual(MAX_BACKOFF_MS + 50);
    expect(delays.at(-1)).toBeGreaterThanOrEqual(MAX_BACKOFF_MS);
    // A session that heard speech resets the backoff.
    rec.emit([["sí", true]]);
    advance(10);
    rec.onend?.();
    advance(0);
    expect(rec.starts.length).toBeGreaterThan(9);
  });

  it("treats no-speech and network as routine, and permission or device errors as the end", () => {
    const { t, rec, states, advance } = setup();
    t.setWanted(true);
    rec.onerror?.({ error: "no-speech" });
    advance(6_000);
    rec.onend?.();
    advance(0);
    expect(rec.starts).toHaveLength(2);

    rec.onerror?.({ error: "not-allowed" });
    rec.onend?.();
    advance(60_000);
    expect(rec.starts).toHaveLength(2);
    expect(states.at(-1)).toEqual({
      kind: "unavailable",
      reason: "Microphone access for speech recognition was denied.",
    });
    t.setWanted(true);
    expect(rec.starts).toHaveLength(2);
  });

  it("stops on mute (the phrase in progress still arrives) and resumes on unmute", () => {
    const { t, rec, phrases, states, advance } = setup();
    t.setWanted(true);
    advance(1_000);
    t.setWanted(false); // muted
    expect(rec.stops).toBe(1);
    rec.emit([["última frase", true]]);
    rec.onend?.();
    advance(60_000);
    expect(rec.starts).toHaveLength(1);
    expect(states.at(-1)).toEqual({ kind: "off" });
    expect(phrases.map(([text]) => text)).toEqual(["última frase"]);
    t.setWanted(true); // unmuted
    expect(rec.starts).toHaveLength(2);
  });

  it("restarts on a new microphone track, and stops for good when disposed", () => {
    const { t, rec, advance } = setup();
    const a = { id: "a" } as MediaStreamTrack;
    const b = { id: "b" } as MediaStreamTrack;
    t.setWanted(true, a);
    expect(rec.starts).toEqual([a]);
    t.setWanted(true, b);
    expect(rec.stops).toBe(1);
    rec.onend?.();
    advance(0);
    expect(rec.starts).toEqual([a, b]);
    t.dispose();
    expect(rec.aborts).toBe(1);
    rec.onend?.();
    advance(60_000);
    expect(rec.starts).toHaveLength(2);
  });
});
