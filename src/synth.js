/* ============================================================================
   cat-translator :: synth.js
   Meow synthesis. Pure maths + typed arrays, so the exact same code path runs
     * live in the browser (rendered into an AudioBuffer and played), and
     * offline in Node (tools/render.mjs -> .wav files)
   which means the recogniser is trained on precisely the signal the user hears.

   Signal chain, all in here:
     glottal pulse train (harmonic buzz) + breath noise
        -> 3 cascaded band-pass "formant" resonators that glide over time
        -> + low-frequency purr rumble (25 Hz pulse train)
        -> amplitude envelope (attack / release / chatter flutter / purr sway)
        -> soft clip + normalise
   ========================================================================== */
(function (g) {
  'use strict';

  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smoothstep = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  const lerp = (a, b, u) => a + (b - a) * u;

  /** mulberry32 – deterministic PRNG so a token always renders identically */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* vowel -> formant glide (keeps a "me-ow" diphthong in every meow) */
  const GLIDE = {
    a: { f1: [0.86, 1.16], f2: [1.22, 0.86] },
    e: { f1: [0.92, 1.14], f2: [1.12, 0.90] },
    i: { f1: [1.00, 1.12], f2: [1.14, 1.00] },
    o: { f1: [1.12, 0.95], f2: [0.88, 1.06] },
    u: { f1: [1.06, 0.98], f2: [0.86, 1.04] },
    y: { f1: [1.02, 1.10], f2: [1.20, 0.94] },
  };

  const LEAD = 0.045;    // filter settling before the mouth opens

  /* ------------------------------------------------------------------- plan */
  function plan(desc, sr, opts) {
    opts = opts || {};
    const qScale = opts.qScale || 1;
    const dur = Math.max(0.14, desc.dur);
    const total = dur + LEAD + 0.06;
    const n = Math.ceil(total * sr);
    const t0 = LEAD, t1 = LEAD + dur;
    const vStart = t0 + 0.05 * dur, vEnd = t1 - 0.05 * dur;
    const tone = desc.tone || [0, 0, 0];
    const isSpecial = !!desc.special;
    const rand = rng(g.MEOW_TOKENS.hash(desc.token || 'x') >>> 0);

    const glottal = new Float32Array(n);
    const noise = new Float32Array(n);
    const purr = new Float32Array(n);
    const gain = new Float32Array(n);
    const purrGain = new Float32Array(n);
    const f1 = new Float32Array(n), f2 = new Float32Array(n), f3 = new Float32Array(n), q = new Float32Array(n);

    const glide = GLIDE[desc.vowel] || GLIDE.a;
    const F = desc.formants || [1000, 1600, 2900];
    const fs = desc.formantScale || 1;

    const vibF = desc.vibrato || 5, vibD = desc.vibratoDepth != null ? desc.vibratoDepth : 0.02;
    const flutterRate = desc.flutter || 0;
    const purrRate = desc.rate || 26;
    const purrLevel = desc.purr || 0;
    let purrLow = 0, purrLow2 = 0, purrA2 = 1 - Math.exp(-2 * Math.PI * 300 / sr);
    const noiseLevel = desc.noise != null ? desc.noise : 0.02;

    // harmonic count is band-limited to ~9 kHz rather than to Nyquist, so a meow
    // rendered at 16 kHz sounds (and measures) like the same meow at 48 kHz
    const K = Math.min(30, Math.max(4, Math.floor(9000 / (desc.base * 1.4))));
    const hAmp = new Float32Array(K + 1), hPh = new Float32Array(K + 1);
    for (let k = 1; k <= K; k++) {
      hAmp[k] = Math.pow(0.9, k - 1) / Math.pow(k, 0.5);
      hPh[k] = rand() * Math.PI * 2;
    }
    /* A real purr is a ~26 Hz rumble: the fundamental and a few harmonics, all
       below the vowel band. An earlier version ran 34 harmonics up to 900 Hz,
       which buried F1/F2 and made purr-coloured meows unreadable — every purr
       meow then sounded like every other purr meow. */
    const purrK = Math.max(2, Math.floor(300 / purrRate));
    const purrAmp = new Float32Array(purrK + 1);
    for (let k = 1; k <= purrK; k++) purrAmp[k] = 1 / Math.pow(k, 2.2);

    let phase = 0, phaseP = 0, ns = Math.floor(rand() * n);
    const amb = rand() * 3;
    const chatterOn = desc.special === 'chatter' || flutterRate > 0;

    for (let i = 0; i < n; i++) {
      const t = i / sr;
      /* ---- pitch contour (semitones -> Hz) ---- */
      let st;
      if (t <= vStart) st = tone[0];
      else if (t >= vEnd) st = tone[2];
      else {
        const u = (t - vStart) / (vEnd - vStart);
        st = u < 0.35 ? lerp(tone[0], tone[1], smoothstep(u / 0.35))
                      : lerp(tone[1], tone[2], smoothstep((u - 0.35) / 0.65));
      }
      let f0 = desc.base * Math.pow(2, st / 12);
      if (vibD) f0 *= 1 + vibD * Math.sin(2 * Math.PI * vibF * t + amb);
      if (chatterOn) f0 *= 1 + 0.05 * Math.sin(2 * Math.PI * (flutterRate * 0.5) * t);
      f0 *= 1 + 0.004 * Math.sin(2 * Math.PI * 7.3 * t + amb * 2);

      phase += f0 / sr;
      if (phase > 1) phase -= Math.floor(phase);

      /* ---- glottal buzz (band-limited pulse train) ---- */
      let gl = 0;
      const maxK = Math.min(K, Math.floor(0.45 * sr / f0));
      for (let k = 1; k <= maxK; k++) gl += hAmp[k] * Math.sin(2 * Math.PI * k * phase + hPh[k]);
      glottal[i] = gl;

      /* ---- breath noise ---- */
      ns = (ns * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (ns / 0x3fffffff) - 1;

      /* ---- purr rumble ---- */
      if (purrLevel > 0) {
        phaseP += purrRate / sr;
        if (phaseP > 1) phaseP -= 1;
        let p = 0;
      const purrA2 = 1 - Math.exp(-2 * Math.PI * 300 / sr);
        for (let k = 1; k <= purrK; k++) p += purrAmp[k] * Math.sin(2 * Math.PI * k * phaseP);
        purrLow = purrLow + purrA2 * (p - purrLow);        // 12 dB/oct at 300 Hz
        purrLow2 = purrLow2 + purrA2 * (purrLow - purrLow2);
        purr[i] = purrLow2 * 1.6;
      }

      /* ---- amplitude envelope ---- */
      const att = 0.016, rel = 0.05;
      let env = smoothstep((t - t0) / att) * smoothstep((t1 - t) / rel);
      env = clamp(env, 0, 1);
      if (chatterOn) env *= 1 - 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * flutterRate * t));
      const sway = 1 - (isSpecial && desc.special === 'purr' ? 0.18 : 0.05) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.2 * t + amb));
      gain[i] = env;
      purrGain[i] = purrLevel * env * sway * (desc.special === 'purr' ? 1 : 0.8);

      /* ---- formant glide ---- */
      const u = clamp((t - vStart) / Math.max(1e-4, vEnd - vStart), 0, 1);
      const g1 = lerp(glide.f1[0], glide.f1[1], smoothstep(u));
      const g2 = lerp(glide.f2[0], glide.f2[1], smoothstep(u));
      const g3 = lerp(0.95, 1.08, smoothstep(u));
      f1[i] = F[0] * fs * g1;
      f2[i] = F[1] * fs * g2;
      f3[i] = F[2] * fs * g3;
      q[i] = qScale;
    }

    return { sr, n, dur: total, glottal, noise, purr, gain, purrGain, f1, f2, f3, q,
             noiseLevel, voice: { qScale } };
  }

  /* ------------------------------------------------------- resonator cascade */
  function Resonator(freq, sr, Q, gain) {
    const w0 = 2 * Math.PI * clamp(freq, 20, sr * 0.45) / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = (alpha * gain) / a0; this.b1 = 0; this.b2 = (-alpha * gain) / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  Resonator.prototype.run = function (x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  };
  Resonator.prototype.retune = function (freq, Q, gain, sr) {
    const w0 = 2 * Math.PI * clamp(freq, 20, sr * 0.45) / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = (alpha * gain) / a0; this.b1 = 0; this.b2 = (-alpha * gain) / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0; this.a2 = (1 - alpha) / a0;
  };

  /** pre-filter mix -> formant cascade -> purr -> envelope -> soft clip */
  function renderSamples(p, sr) {
    sr = sr || p.sr;
    const n = p.n;
    const out = new Float32Array(n);
    const QA = [3.2, 4.2, 5.0];      // broad, cat-like formants (see VOWELS)
    const GA = [1.0, 0.85, 0.6];
    const r1 = new Resonator(p.f1[0], sr, QA[0] * p.voice.qScale, GA[0]);
    const r2 = new Resonator(p.f2[0], sr, QA[1] * p.voice.qScale, GA[1]);
    const r3 = new Resonator(p.f3[0], sr, QA[2] * p.voice.qScale, GA[2]);
    const BLOCK = 32;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      if (i % BLOCK === 0) {
        const qs = p.voice.qScale;
        r1.retune(p.f1[i], QA[0] * qs, GA[0], sr);
        r2.retune(p.f2[i], QA[1] * qs, GA[1], sr);
        r3.retune(p.f3[i], QA[2] * qs, GA[2], sr);
      }
      const nz = p.noise[i] * p.noiseLevel;
      const x = p.glottal[i] * 0.85 + nz;
      /* The formant cascade has to dominate: an uncoloured glottal buzz carries no
         vowel information, and the recogniser reads vowels out of the spectrum. */
      let y = r1.run(x); y = r2.run(y); y = r3.run(y);
      y = y * 7.0 + x * 0.02;                      // formant colour, barely any raw buzz
      y += nz * (0.4 + 6 * p.noiseLevel);          // breathy tokens stay broadband (hiss!)
      y += p.purr[i] * p.purrGain[i];
      y *= p.gain[i];
      y = Math.tanh(y * 1.2) * 0.92;               // soft clip: warmth + safety
      out[i] = y;
      const a = Math.abs(y); if (a > peak) peak = a;
    }
    const k = 0.86 / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
  }

  /**
   * Render a whole utterance (a run of tokens) with natural gaps.
   * opts: {sr, qScale, gap, voicePitch, voiceSpeed}
   */
  function renderUtterance(descs, opts) {
    opts = opts || {};
    const sr = opts.sr || 44100;
    const pieces = [];
    let total = 0;
    descs.forEach((d, idx) => {
      const dd = Object.assign({}, d);
      if (opts.voicePitch) {
        dd.base = d.base * opts.voicePitch;
        /* a deeper voice is a bigger cat: its formants move with the pitch, and
           this must match what MEOW_ENGINE.describeTokens(voice) does */
        dd.formantScale = (d.formantScale || 1) * opts.voicePitch;
      }
      if (opts.voiceSpeed) dd.dur = d.dur * opts.voiceSpeed;
      const p = plan(dd, sr, opts);
      const s = renderSamples(p, sr);
      pieces.push(s); total += s.length;
      if (idx < descs.length - 1) {
        const gap = Math.max(12, Math.round((opts.gap != null ? opts.gap : 0.055) * sr));
        pieces.push(new Float32Array(gap)); total += gap;
      }
    });
    const out = new Float32Array(total);
    let o = 0;
    for (const s of pieces) { out.set(s, o); o += s.length; }
    if (descs.length > 1) {
      // global utterance envelope so a many-meow sentence doesn't clip
      const ramp = Math.round(0.01 * sr);
      for (let i = 0; i < ramp; i++) { const k = i / ramp; out[i] *= k; out[out.length - 1 - i] *= k; }
    }
    return out;
  }

  /* ------------------------------------------------------------- WAV encoder */
  function encodeWav(samples, sr, channels) {
    channels = channels || 1;
    const len = samples.length;
    const bytes = 44 + len * 2 * channels;
    const buf = new ArrayBuffer(bytes);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, channels, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2 * channels, true); v.setUint16(32, 2 * channels, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, len * 2 * channels, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      const s = clamp(samples[i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return buf;
  }

  g.MEOW_SYNTH = { plan, renderSamples, renderUtterance, encodeWav, Resonator, rng, clamp, smoothstep };
})(typeof globalThis !== 'undefined' ? globalThis : window);
