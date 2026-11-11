import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_BUDGET_CHARS,
  audioScript,
  elevenLabsKey,
  elevenLabsVoice,
  scriptChunks,
  speak,
  useNewsAudioClients,
  useNewsAudioFetch,
  spokenDay,
  spokenSeconds,
} from "../src/lib/newsAudio";

describe("the AI News summary in audio (Phase 54)", () => {
  const insights = {
    day: "2026-11-09",
    stories: [
      {
        headline: "OpenAI lanza agentes",
        summary: "Resumen.",
        whyItMatters: "Cambia la **automatización** de procesos",
        sourceName: "TechCrunch",
        link: "https://techcrunch.com/a",
        thumbnailUrl: null,
        pubDate: null,
      },
      {
        headline: "Nvidia invierte",
        summary: "Una ronda grande. Ver https://example.com",
        sourceName: "The Verge",
        link: "https://theverge.com/b",
        thumbnailUrl: null,
        pubDate: null,
      },
    ],
    trends: [{ topic: "Agentes", text: "Todos lanzan **agentes** para empresas" }],
    takeaways: [
      { lead: "Probar agentes", body: "en un cliente actual.", horizon: "ahora" as const },
    ],
  };

  it("reads the day and the top stories in a sentence each: no trends, actions, markdown or links", () => {
    const script = audioScript(insights);
    expect(script.split("\n\n")).toEqual([
      "Update de noticias.",
      "OpenAI lanza agentes. Resumen.",
      // Only the first sentence of what happened; links dropped.
      "Nvidia invierte. Una ronda grande.",
    ]);
    expect(script).not.toMatch(/\*\*|https?:|Por qué importa|Fuente/);
  });

  it("fits a minute: as many stories as the budget takes, always the first", () => {
    const long = {
      ...insights.stories[0]!,
      headline: "Un titular largo sobre inteligencia artificial que ocupa bastante",
      summary: `${"palabra ".repeat(40).trim()}. Segunda frase que no se lee.`,
    };
    const script = audioScript({ ...insights, stories: [long, long, long, long, long] });
    expect(script.length).toBeLessThanOrEqual(AUDIO_BUDGET_CHARS);
    expect(script).not.toContain("Segunda frase");
    // Out of time: the last ones as the headline alone.
    expect(script.split("\n\n").at(-1)).toBe(long.headline + ".");
    // One enormous story is still read, as its headline.
    const huge = { ...long, summary: `${"x".repeat(2000)}.` };
    expect(audioScript({ ...insights, stories: [huge, long] })).toContain(long.headline);
  });

  it("says a new Claude model first (Phase 56)", () => {
    const script = audioScript({
      ...insights,
      claudeAlert: {
        status: "launched",
        model: "Claude Opus 6",
        headline: "h",
        summary: "Disponible hoy en la API.",
        evidence: [],
        from: "analysis",
      },
    });
    const [, second] = script.split("\n\n");
    expect(second).toBe(
      "Anthropic lanzó un nuevo modelo de Claude: Claude Opus 6. Disponible hoy en la API.",
    );
  });

  it("cuts the script into pieces Polly accepts, between paragraphs then sentences", () => {
    const script = ["Uno. Dos.", "Tres.", "x".repeat(25) + ". " + "y".repeat(25) + "."].join(
      "\n\n",
    );
    const chunks = scriptChunks(script, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(script.replace(/\s+/g, ""));
    expect(scriptChunks("corto")).toEqual(["corto"]);
  });

  it("names the day in Spanish and guesses how long it plays", () => {
    expect(spokenDay("2026-11-09")).toBe("lunes, 9 de noviembre");
    expect(spokenDay("nope")).toBe("");
    expect(spokenSeconds(1500)).toBe(100);
  });
});

describe("the voice: ElevenLabs when its key is set, Polly otherwise (Phase 61)", () => {
  const pollySend = vi.fn(async () => ({
    AudioStream: { transformToByteArray: async () => new Uint8Array([9, 9]) },
  }));
  beforeEach(() => {
    pollySend.mockClear();
    elevenLabsKey.reset();
    elevenLabsVoice.reset();
    useNewsAudioClients({ polly: { send: pollySend } as never });
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    elevenLabsKey.reset();
    elevenLabsVoice.reset();
    useNewsAudioFetch(null);
    useNewsAudioClients(null);
  });

  it("reads with Polly while there's no key", async () => {
    const network = vi.fn();
    useNewsAudioFetch(network as never);
    expect(await speak("Hola.")).toEqual({
      audio: new Uint8Array([9, 9]),
      voice: "polly",
      note: expect.stringContaining("No se encontró la clave"),
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("reads with ElevenLabs: the multilingual model, the configured voice, the key in its header", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.ELEVENLABS_VOICE_ID = "voice123";
    const network = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    useNewsAudioFetch(network as never);
    expect(await speak("Hola.")).toEqual({ audio: new Uint8Array([1, 2, 3]), voice: "elevenlabs" });
    const [url, init] = network.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
    );
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Hola.",
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.35,
        use_speaker_boost: true,
        speed: 1.12,
      },
    });
    expect(pollySend).not.toHaveBeenCalled();
  });

  it("reads plainly when ElevenLabs rejects a setting, rather than falling to Polly", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const bodies: Array<Record<string, unknown>> = [];
    useNewsAudioFetch((async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? new Response("unsupported", { status: 400 })
        : new Response(new Uint8Array([1, 2, 3]));
    }) as never);
    expect((await speak("Hola.")).voice).toBe("elevenlabs");
    expect(bodies[1]).toEqual({ text: "Hola.", model_id: "eleven_multilingual_v2" });
  });

  it("falls back to Polly when ElevenLabs refuses (no credits, an outage)", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    useNewsAudioFetch((async () => new Response("quota_exceeded", { status: 401 })) as never);
    const read = await speak("Hola.");
    expect(read.voice).toBe("polly");
    // Why, for the page.
    expect(read.note).toBe("ElevenLabs answered 401: quota_exceeded");
    expect(pollySend).toHaveBeenCalledTimes(1);
  });
});
