/**
 * Incoming-call ring synthesized with Web Audio (no asset to download): two
 * short tones every 2.5 s. Browsers may refuse to start audio before any user
 * gesture on the page; the visual notification still shows in that case.
 */
let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function beep(ctx: AudioContext, at: number, frequency: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
  gain.gain.linearRampToValueAtTime(0, at + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.4);
}

function ringOnce(ctx: AudioContext): void {
  beep(ctx, ctx.currentTime, 880);
  beep(ctx, ctx.currentTime + 0.45, 660);
}

export function startRingtone(): void {
  stopRingtone();
  try {
    context = new AudioContext();
    const ctx = context;
    void ctx.resume().catch(() => {});
    ringOnce(ctx);
    timer = setInterval(() => ringOnce(ctx), 2500);
  } catch {
    context = null; // Web Audio unavailable: ring silently.
  }
}

export function stopRingtone(): void {
  clearInterval(timer);
  timer = undefined;
  void context?.close().catch(() => {});
  context = null;
}
