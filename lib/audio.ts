import type { Side } from "./types";

/**
 * Tiny Web Audio synth for big-trade alerts. No audio files, no allocations
 * beyond one oscillator + gain node per beep. Throttled so a burst of prints
 * doesn't turn into noise.
 */
export class TradeAlertSound {
  private ctx: AudioContext | null = null;
  private lastPlayed = 0;
  private readonly minGapMs = 90;

  /** Must be called from a user gesture (browser autoplay policy). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  play(side: Side, usd: number, threshold: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;

    const now = performance.now();
    if (now - this.lastPlayed < this.minGapMs) return;
    this.lastPlayed = now;

    // Larger trades → louder, longer, and slightly lower pitch.
    const magnitude = Math.min(Math.log10(Math.max(usd / threshold, 1)) + 1, 3); // 1..3
    const base = side === "BUY" ? 880 : 330;
    const freq = base / Math.pow(1.12, magnitude - 1);
    const duration = 0.06 + 0.05 * magnitude;
    const volume = 0.04 + 0.04 * magnitude;

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = side === "BUY" ? "triangle" : "sawtooth";
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(side === "BUY" ? freq * 1.25 : freq * 0.8, t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
