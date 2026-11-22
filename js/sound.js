/** Tiny synthesized sound effects (no audio assets needed). */

export class Sounds {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
  }

  setEnabled(value) {
    this.enabled = !!value;
  }

  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!Ctx) return null;
      try { this.ctx = new Ctx(); } catch { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  tone({ freq = 440, endFreq = freq, type = 'sine', duration = 0.12, gain = 0.12, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  noise({ duration = 0.08, gain = 0.08, delay = 0, freq = 900 } = {}) {
    const ctx = this.ensure();
    if (!ctx) return;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.4);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.1;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start(ctx.currentTime + delay);
  }

  play(kind = 'move') {
    if (!this.enabled) return;
    switch (kind) {
      case 'move':
        this.tone({ freq: 320, endFreq: 160, type: 'triangle', duration: 0.09, gain: 0.1 });
        this.noise({ duration: 0.05, gain: 0.05, freq: 700 });
        break;
      case 'capture':
        this.tone({ freq: 220, endFreq: 90, type: 'triangle', duration: 0.16, gain: 0.14 });
        this.noise({ duration: 0.12, gain: 0.1, freq: 420 });
        break;
      case 'castle':
        this.tone({ freq: 300, endFreq: 170, type: 'triangle', duration: 0.08, gain: 0.09 });
        this.tone({ freq: 300, endFreq: 170, type: 'triangle', duration: 0.08, gain: 0.09, delay: 0.1 });
        break;
      case 'check':
        this.tone({ freq: 720, endFreq: 720, type: 'sine', duration: 0.11, gain: 0.09 });
        this.tone({ freq: 1080, endFreq: 1080, type: 'sine', duration: 0.14, gain: 0.07, delay: 0.1 });
        break;
      case 'end':
        this.tone({ freq: 523, endFreq: 523, type: 'sine', duration: 0.5, gain: 0.08 });
        this.tone({ freq: 659, endFreq: 659, type: 'sine', duration: 0.5, gain: 0.06, delay: 0.06 });
        this.tone({ freq: 784, endFreq: 784, type: 'sine', duration: 0.55, gain: 0.05, delay: 0.12 });
        break;
      case 'error':
        this.tone({ freq: 190, endFreq: 130, type: 'sawtooth', duration: 0.16, gain: 0.06 });
        break;
      case 'notify':
        this.tone({ freq: 880, endFreq: 880, type: 'sine', duration: 0.07, gain: 0.05 });
        break;
      default:
        break;
    }
  }
}
