/**
 * Microphone capture with simple voice activity detection (VAD),
 * 16 kHz mono WAV encoding, and speech-to-text through the local
 * whisper.cpp server. Falls back to the browser's SpeechRecognition
 * when the local Whisper server is unavailable.
 */

const TARGET_RATE = 16000;
const SILENCE_MS = 850;
const SINGLE_WAIT_MS = 7000;
const CONTINUOUS_WAIT_MS = 20000;
const MAX_SPEECH_MS = 12000;

const HALLUCINATIONS = [
  /^\s*(legendas?|subtitles?|subs)\b/i,
  /^\s*(obrigad[oa] por assistir|thank you for watching)\b/i,
  /^\s*(thank you\.?|thanks\.?|you\.?)\s*$/i,
  /amara\.org/i,
  /^\s*[\[(](m[úu]sica|music|aplausos|applause|sil[êe]ncio|silence)[\])]\s*$/i,
];

function cleanTranscript(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!t) return '';
  if (HALLUCINATIONS.some((re) => re.test(t))) return '';
  return t;
}

function resampleLinear(input, fromRate, toRate) {
  if (!input.length || fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function trimAndNormalize(samples, rate) {
  // find voiced region by RMS in 20 ms windows
  const win = Math.round(rate * 0.02);
  const energies = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    energies.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const peakWin = Math.max(...energies, 0);
  const floor = peakWin * 0.12;
  let start = 0;
  let end = energies.length - 1;
  while (start < energies.length && energies[start] < Math.max(floor, 0.008)) start++;
  while (end > start && energies[end] < Math.max(floor, 0.008)) end--;
  if (start > end) return new Float32Array(0);
  const pad = Math.round(rate * 0.22);
  const startSample = Math.max(0, start * win - pad);
  const endSample = Math.min(samples.length, (end + 1) * win + pad);
  const trimmed = samples.slice(startSample, endSample);

  let peak = 0;
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]));
  const gain = peak > 0.001 ? Math.min(6, 0.92 / peak) : 1;
  const out = new Float32Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) out[i] = Math.max(-1, Math.min(1, trimmed[i] * gain));
  return out;
}

export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

class VoiceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export class VoiceInput {
  constructor(options = {}) {
    this.onState = options.onState || (() => {});
    this.onLevel = options.onLevel || (() => {});
    this.onError = options.onError || (() => {});
    this.getLang = options.getLang || (() => 'pt');
    this.getModel = options.getModel || (() => 'small');
    this.serverAvailable = options.serverAvailable !== false;

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.mute = null;
    this.sampleRate = TARGET_RATE;
    this.capture = null;
    this.generation = 0;
    this.timers = new Set();
    this.state = 'idle';
    this.lastLevelAt = 0;
    this.releaseOnIdle = false;
    this.browserRecognition = null;
  }

  setServerAvailable(value) {
    this.serverAvailable = !!value;
  }

  setState(state, detail = {}) {
    this.state = state;
    this.onState(state, detail);
  }

  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  timer(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  async ensureStream() {
    if (this.stream && this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new VoiceError('no_mic', 'Microphone API unavailable');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = error && error.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new VoiceError('not_allowed', 'Microphone permission denied');
      throw new VoiceError('no_mic', 'Could not access the microphone');
    }
    this.stream = stream;

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.source = ctx.createMediaStreamSource(stream);
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;

    try {
      await ctx.audioWorklet.addModule('js/pcm-worklet.js');
      const node = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      node.port.onmessage = (event) => this.handleSamples(event.data);
      this.node = node;
    } catch {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (event) => {
        this.handleSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      this.node = node;
    }
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
  }

  handleSamples(chunk) {
    const cap = this.capture;
    if (!cap || !chunk || !chunk.length) return;
    cap.chunks.push(chunk);
    cap.total += chunk.length;

    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const now = performance.now();

    if (now - this.lastLevelAt > 45) {
      this.lastLevelAt = now;
      this.onLevel(Math.min(1, Math.sqrt(rms) * 2.6));
    }

    if (!cap.hasSpeech) {
      if (cap.total > this.sampleRate * 0.25) {
        // adapt to room noise while nobody is speaking
        cap.noise = cap.noise * 0.97 + rms * 0.03;
      }
      const threshold = Math.max(0.014, cap.noise * 2.4 + 0.006);
      cap.threshold = threshold;
      if (rms > threshold) cap.voiceFrames++;
      else cap.voiceFrames = Math.max(0, cap.voiceFrames - 1);
      if (cap.voiceFrames >= 2) {
        cap.hasSpeech = true;
        cap.speechStart = cap.total - chunk.length * 2;
        cap.lastVoice = cap.total;
        cap.speechSamples = chunk.length;
        this.setState('recording');
        // replace the "waiting for speech" timeout with a maximum utterance length
        this.clearTimers();
        this.timer(() => {
          if (this.capture && this.capture.hasSpeech) this.finalize('max');
        }, MAX_SPEECH_MS);
      }
    } else {
      if (rms > cap.threshold * 1.15) {
        cap.lastVoice = cap.total;
        cap.speechSamples += chunk.length;
      }
      const silenceSamples = (this.sampleRate * SILENCE_MS) / 1000;
      if (cap.total - cap.lastVoice > silenceSamples && cap.speechSamples > this.sampleRate * 0.12) {
        this.finalize('silence');
      }
    }

    if (cap.hasSpeech && cap.total - cap.speechStart > (this.sampleRate * MAX_SPEECH_MS) / 1000) {
      this.finalize('max');
    }
  }

  /**
   * Listen for one utterance.
   * @returns {Promise<{text:string, source:string, ms:number}|null>}
   */
  async listenOnce({ continuous = false } = {}) {
    this.clearTimers();
    this.generation++;
    const gen = this.generation;
    await this.ensureStream();
    if (gen !== this.generation) return null;

    this.capture = {
      chunks: [],
      total: 0,
      hasSpeech: false,
      speechStart: 0,
      lastVoice: 0,
      speechSamples: 0,
      voiceFrames: 0,
      noise: 0.004,
      threshold: 0.014,
    };
    this.setState(continuous ? 'listening' : 'recording');

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, gen, continuous, settled: false };
      const waitMs = continuous ? CONTINUOUS_WAIT_MS : SINGLE_WAIT_MS;
      this.timer(() => {
        if (!this.capture) return;
        if (this.capture.hasSpeech) this.finalize('timeout');
        else if (continuous) {
          this.resetCapture();
          this.setState('listening');
          // resolve null so the session loop can re-check state
          this.settle(null, null);
        } else {
          this.setState('idle');
          this.settle(null, new VoiceError('no_speech', 'No speech detected'));
        }
      }, waitMs);
    });
  }

  resetCapture() {
    this.capture = null;
    this.clearTimers();
  }

  settle(result, error, expected = null) {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    if (expected && pending !== expected) return;
    pending.settled = true;
    this.pending = null;
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  finalize(reason) {
    const cap = this.capture;
    const pending = this.pending;
    if (!cap || !pending) return;
    this.capture = null;
    this.clearTimers();

    if (!cap.hasSpeech || cap.speechSamples < this.sampleRate * 0.1) {
      this.setState('idle');
      if (pending.continuous) {
        this.settle(null, null, pending);
      } else {
        this.settle(null, new VoiceError('no_speech', 'No speech detected'), pending);
      }
      return;
    }

    let samples = new Float32Array(cap.total);
    let offset = 0;
    for (const chunk of cap.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    const start = Math.max(0, cap.speechStart - Math.round(this.sampleRate * 0.25));
    const end = Math.min(samples.length, cap.lastVoice + Math.round(this.sampleRate * 0.4));
    samples = samples.slice(start, end);
    samples = trimAndNormalize(samples, this.sampleRate);
    if (samples.length < this.sampleRate * 0.12) {
      this.setState('idle');
      this.settle(null, pending.continuous ? null : new VoiceError('no_speech', 'No speech detected'), pending);
      return;
    }
    samples = resampleLinear(samples, this.sampleRate, TARGET_RATE);
    const wav = encodeWav(samples, TARGET_RATE);

    this.setState('processing');
    const started = performance.now();
    const lang = this.getLang();
    const model = this.getModel();
    this.transcribe(wav, lang, model)
      .then((text) => {
        const clean = cleanTranscript(text);
        if (!clean) throw new VoiceError('empty', 'Empty transcription');
        if (this.pending === pending) this.setState('idle');
        this.settle({
          text: clean,
          source: 'whisper',
          ms: Math.round(performance.now() - started),
          audioMs: Math.round((samples.length / TARGET_RATE) * 1000),
        }, null, pending);
      })
      .catch(async (error) => {
        // fall back to the browser recognizer when possible
        if (error && error.code === 'aborted') {
          this.settle(null, null, pending);
          return;
        }
        if (error && (error.code === 'empty' || error.code === 'no_speech')) {
          if (this.pending === pending) this.setState('idle');
          this.settle(null, error, pending);
          return;
        }
        try {
          const text = await this.recognizeWithBrowser(lang);
          const clean = cleanTranscript(text);
          if (!clean) throw new VoiceError('empty', 'Empty transcription');
          if (this.pending === pending) this.setState('idle');
          this.settle({
            text: clean,
            source: 'browser',
            ms: Math.round(performance.now() - started),
          }, null, pending);
        } catch (fallbackError) {
          if (this.pending === pending) this.setState('idle');
          const code = error && error.code ? error.code : 'transcribe_failed';
          this.settle(null, new VoiceError(code, (error && error.message) || 'Transcription failed'), pending);
        }
      });
  }

  /** Stop current capture and transcribe whatever was recorded. */
  finishNow() {
    if (!this.capture) return;
    if (this.capture.hasSpeech) this.finalize('manual');
    else this.settle(null, new VoiceError('no_speech', 'No speech detected'));
  }

  /** Abort current listen and release when requested. */
  abortBrowserRecognition() {
    if (!this.browserRecognition) return;
    try {
      this.browserRecognition.abort();
    } catch {
      /* ignore */
    }
    this.browserRecognition = null;
  }

  stop({ release = false } = {}) {
    this.generation++;
    this.abortBrowserRecognition();
    this.resetCapture();
    if (this.pending && !this.pending.settled) {
      this.settle(null, null);
    }
    this.setState('idle');
    if (release) this.release();
  }

  releaseResources() {
    if (this.node) {
      try { this.node.disconnect(); } catch { /* ignore */ }
      this.node = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* ignore */ }
      this.source = null;
    }
    if (this.mute) {
      try { this.mute.disconnect(); } catch { /* ignore */ }
      this.mute = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  release() {
    this.generation++;
    this.abortBrowserRecognition();
    this.resetCapture();
    this.settle(null, null);
    this.releaseResources();
    this.setState('idle');
  }

  async transcribe(blob, lang, model) {
    if (!this.serverAvailable) throw new VoiceError('server_offline', 'Whisper server offline');
    const params = new URLSearchParams({ lang: lang || 'auto', model: model || 'small' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch(`/api/transcribe?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: blob,
        signal: controller.signal,
      });
    } catch (error) {
      this.serverAvailable = false;
      throw new VoiceError(error && error.name === 'AbortError' ? 'timeout' : 'server_error', 'Whisper request failed');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      this.serverAvailable = false;
      throw new VoiceError('server_error', `Whisper server returned ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    if (!data || typeof data.text !== 'string') throw new VoiceError('bad_response', 'Invalid transcription response');
    return data.text;
  }

  browserSupported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  recognizeWithBrowser(lang) {
    const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    if (!SR) return Promise.reject(new VoiceError('no_browser_stt', 'Browser speech recognition unavailable'));
    this.abortBrowserRecognition();
    this.releaseResources();
    return new Promise((resolve, reject) => {
      let settled = false;
      const rec = new SR();
      this.browserRecognition = rec;
      rec.lang = lang === 'en' ? 'en-US' : 'pt-BR';
      rec.interimResults = false;
      rec.continuous = false;
      rec.maxAlternatives = 3;
      const clearRecognition = () => {
        if (this.browserRecognition === rec) this.browserRecognition = null;
      };
      rec.onresult = (event) => {
        settled = true;
        clearRecognition();
        const results = event.results && event.results[0];
        resolve(results && results[0] ? results[0].transcript : '');
      };
      rec.onerror = (event) => {
        settled = true;
        clearRecognition();
        const code = event && event.error;
        reject(new VoiceError(code === 'not-allowed' ? 'not_allowed' : 'browser_stt_failed', code || 'Browser speech error'));
      };
      rec.onend = () => {
        clearRecognition();
        if (!settled) {
          settled = true;
          reject(new VoiceError('no_speech', 'No speech detected'));
        }
      };
      try {
        rec.start();
        this.setState('recording');
      } catch (error) {
        clearRecognition();
        settled = true;
        reject(new VoiceError('browser_stt_failed', 'Could not start browser speech recognition'));
      }
    });
  }
}

export { VoiceError };
