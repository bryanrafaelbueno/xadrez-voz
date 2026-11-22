/**
 * Narration: a local Brazilian Portuguese neural voice (tiny-voca, served
 * by /api/tts) plus the Web Speech API as a fallback and for English.
 */

const COORD = /\b([a-h])([1-8])\b/gi;

function browserText(text) {
  return String(text)
    .replace(COORD, (_, file, rank) => `${file} ${rank}`)
    .replace(/\bO-O-O\b/g, 'O O O')
    .replace(/\bO-O\b/g, 'O O');
}

export class Narrator {
  constructor({ lang = 'pt', enabled = true, endpoint = '/api/tts', ttsVoice = 'F' } = {}) {
    this.lang = lang;
    this.enabled = enabled;
    this.endpoint = endpoint;
    this.ttsVoice = ttsVoice === 'M' ? 'M' : 'F';
    this.serverTts = false;
    this.browserSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.browserVoice = null;
    this.token = 0;
    this.currentFinish = null;
    this.audio = null;
    this.audioUrl = null;
    this.abortController = null;
    if (this.browserSupported) {
      this.loadVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.loadVoices());
    }
  }

  setLang(lang) {
    this.lang = lang === 'en' ? 'en' : 'pt';
    this.browserVoice = null;
    this.loadVoices();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) this.cancel();
  }

  setServerTts(available) {
    this.serverTts = !!available;
  }

  setTtsVoice(voice) {
    this.ttsVoice = String(voice).toUpperCase() === 'M' ? 'M' : 'F';
  }

  setEndpoint(endpoint) {
    this.endpoint = endpoint || '/api/tts';
  }

  loadVoices() {
    if (!this.browserSupported) return;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return;
    const prefix = this.lang === 'en' ? 'en' : 'pt';
    const candidates = voices.filter((voice) => (voice.lang || '').toLowerCase().startsWith(prefix));
    if (!candidates.length) {
      this.browserVoice = null;
      return;
    }
    const score = (voice) => {
      const name = (voice.name || '').toLowerCase();
      const lang = (voice.lang || '').toLowerCase();
      let value = 0;
      if (this.lang === 'pt' && lang === 'pt-br') value += 10;
      if (this.lang === 'en' && lang === 'en-us') value += 8;
      if (this.lang === 'en' && lang === 'en-gb') value += 5;
      if (/natural|neural|google|microsoft/.test(name)) value += 4;
      if (/luciana|francisca|thalita|maria|joana|fernanda|zira|aria|guy|david|mark/.test(name)) value += 2;
      return value;
    };
    candidates.sort((a, b) => score(b) - score(a));
    this.browserVoice = candidates[0];
  }

  cancel() {
    this.token++;
    if (this.currentFinish) {
      const finish = this.currentFinish;
      this.currentFinish = null;
      finish();
    }
    if (this.browserSupported) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* ignore */ }
      this.abortController = null;
    }
    this.stopAudio();
  }

  stopAudio() {
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.src = '';
      } catch { /* ignore */ }
      this.audio = null;
    }
    if (this.audioUrl) {
      try { URL.revokeObjectURL(this.audioUrl); } catch { /* ignore */ }
      this.audioUrl = null;
    }
  }

  /**
   * Speak one phrase. Resolves when the audio ends, fails or is cancelled.
   * The local pt-BR voice is used for Portuguese whenever the server has it.
   */
  speak(text, { force = false } = {}) {
    if (!text || (!this.enabled && !force)) return Promise.resolve();
    this.cancel();
    const token = this.token;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.currentFinish === finish) this.currentFinish = null;
        resolve();
      };
      this.currentFinish = finish;

      const useLocal = this.lang === 'pt' && this.serverTts;
      if (useLocal) {
        this.speakLocal(text, token).then(() => {
          finish();
        }).catch((error) => {
          if (token !== this.token) {
            finish();
            return;
          }
          if (typeof console !== 'undefined') console.warn('Voz local falhou; usando navegador.', error);
          this.speakBrowser(text, token, finish);
        });
      } else {
        this.speakBrowser(text, token, finish);
      }
    });
  }

  async speakLocal(text, token) {
    const controller = new AbortController();
    this.abortController = controller;
    const guard = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: String(text).slice(0, 600),
          lang: 'pt-BR',
          voice: this.ttsVoice,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(guard);
    }
    if (!response.ok) {
      throw new Error(`TTS respondeu ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size || token !== this.token) return;
    const url = URL.createObjectURL(blob);
    this.audioUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    audio.preload = 'auto';

    await new Promise((resolve, reject) => {
      let settled = false;
      let playGuard = null;
      const done = (error) => {
        if (settled) return;
        settled = true;
        if (playGuard) clearTimeout(playGuard);
        audio.onended = null;
        audio.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      audio.onended = () => done(null);
      audio.onerror = () => done(new Error('Falha ao reproduzir a voz.'));
      audio.onloadedmetadata = () => {
        if (playGuard) clearTimeout(playGuard);
        const duration = Number.isFinite(audio.duration) ? audio.duration : 6;
        playGuard = setTimeout(() => done(null), Math.min(30000, duration * 1000 + 2500));
      };
      playGuard = setTimeout(() => done(new Error('Tempo esgotado ao tocar a voz.')), 8000);
      audio.play().catch((error) => done(error));
    }).finally(() => {
      this.stopAudio();
    });
  }

  speakBrowser(text, token, finish) {
    if (!this.browserSupported) {
      finish();
      return;
    }
    if (this.lang === 'pt' && !this.browserVoice) {
      // Avoid reading Portuguese with an English system voice when the local
      // pt-BR model is unavailable.
      finish();
      return;
    }
    if (token !== this.token) {
      finish();
      return;
    }
    const spoken = browserText(text);
    let guard = null;
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      if (guard) clearTimeout(guard);
      finish();
    };
    try {
      const utter = new SpeechSynthesisUtterance(spoken);
      utter.lang = this.lang === 'en' ? 'en-US' : 'pt-BR';
      if (this.browserVoice) utter.voice = this.browserVoice;
      utter.rate = 1.04;
      utter.pitch = 1;
      utter.volume = 1;
      utter.onend = complete;
      utter.onerror = complete;
      guard = setTimeout(complete, Math.min(22000, 2800 + spoken.length * 90));
      window.speechSynthesis.speak(utter);
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    } catch {
      complete();
    }
  }
}
