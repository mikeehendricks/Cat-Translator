/* ============================================================================
   cat-translator :: match.js
   The listening half: audio -> meow fingerprint -> token sequence -> English.

   A fingerprint is 32 numbers:
     c0..c4        pitch path across the meow, semitones vs its own median
     f0Range       how far that path swings
     logF0med      absolute pitch (low weight: cats differ)
     logDur        length
     voicedFrac    how sustained vs spiky
     harmonicity   autocorrelation peak -> tonal vs noisy (hiss lives here)
     flatness      spectral flatness -> breath
     rumble        18-45 Hz share -> the purr engine
     modul         15-40 Hz envelope modulation -> chatter / trill
     t50, t90       when 50% / 90% of the energy has arrived (attack vs tail)
     centroid      spectral brightness
     tilt          log-frequency slope of the spectrum (breath/brightness)
     b0..b15       de-tilted energy shares in 16 log bands -> vowel colour
   Fingerprints are compared z-scored against references built by
   tools/build-templates.mjs from synth.js output, so speaker and listener
   agree by construction.
   ========================================================================== */
(function (g) {
  'use strict';

  const N_BANDS = 16;
  const BANDS = (() => {
    const edge = (i) => 200 * Math.pow(6400 / 200, i / N_BANDS);
    const e = []; for (let i = 0; i <= N_BANDS; i++) e.push(edge(i));
    return e;
  })();

  const FEATURES = ['c0', 'c1', 'c2', 'c3', 'c4', 'f0Range', 'logF0med', 'logDur', 'voicedFrac',
    'harmonicity', 'flatness', 'rumble', 'modul', 't50', 't90', 'centroid', 'tilt']
    .concat(Array.from({ length: N_BANDS }, (_, i) => 'b' + i));

  const DEFAULT_W = {
    c0: 1.4, c1: 1.6, c2: 1.6, c3: 1.5, c4: 1.4, f0Range: 1.0, logF0med: 0.2, logDur: 1.1,
    voicedFrac: 0.7, harmonicity: 1.1, flatness: 1.1, rumble: 1.4, modul: 1.0,
    t50: 0.9, t90: 0.8, centroid: 1.2, tilt: 1.0,
  };
  for (let i = 0; i < N_BANDS; i++) DEFAULT_W['b' + i] = 1.0;

  /* ------------------------------------------------------------- small FFT */
  const TW = new Map(), REV = new Map();
  function twiddles(n) {
    let t = TW.get(n);
    if (!t) {
      t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
      for (let i = 0; i < n / 2; i++) { const a = -2 * Math.PI * i / n; t.cos[i] = Math.cos(a); t.sin[i] = Math.sin(a); }
      TW.set(n, t);
    }
    return t;
  }
  function revTable(n) {
    let r = REV.get(n);
    if (!r) {
      r = new Int32Array(n);
      const bits = Math.round(Math.log2(n));
      for (let i = 0; i < n; i++) {
        let x = i, y = 0;
        for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; }
        r[i] = y;
      }
      REV.set(n, r);
    }
    return r;
  }
  /** in-place complex FFT, cached twiddles + bit reversal */
  function fft(re, im) {
    const n = re.length;
    const rev = revTable(n), tw = twiddles(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const cr = tw.cos[k * step], ci = tw.sin[k * step];
          const a = i + k, b = a + half;
          const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
        }
      }
    }
  }
  /** normalised autocorrelation of one window (ac[0] = 1) via FFT */
  /**
   * Normalised autocorrelation of one window: r(l) = sum x[i]x[i+l] /
   * sqrt(E[0..n-l) * E[l..n)). Dividing by the energy actually available at
   * that lag is what stops short lags (and a purr's dense harmonic comb) from
   * winning on raw magnitude alone.
   */
  /**
   * Normalised autocorrelation of one window: r(l) = sum x[i]x[i+l] /
   * sqrt(E[0..n-l) * E[l..n)). Dividing by the energy actually available at
   * that lag is what stops short lags (and a purr's dense harmonic comb) from
   * winning on raw magnitude alone. The correlation is computed with a
   * zero-padded FFT, i.e. linear, not circular — circular summing used to
   * inflate every lag and drag the pitch estimate off to nonsense.
   */
  function acf(frame, out) {
    const n = frame.length, N = 2 * n;
    const re = new Float64Array(N), im = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += frame[i];
    mean /= n;
    for (let i = 0; i < n; i++) re[i] = frame[i] - mean;
    fft(re, im);
    for (let k = 0; k < N; k++) { const p = re[k] * re[k] + im[k] * im[k]; re[k] = p; im[k] = 0; }
    fft(re, im);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = frame[i] - mean;
    const headE = new Float64Array(n + 1), tailE = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      headE[i + 1] = headE[i] + x[i] * x[i];
      tailE[i + 1] = tailE[i] + x[n - 1 - i] * x[n - 1 - i];
    }
    for (let l = 0; l < out.length; l++) {
      const avail = headE[n - l] * tailE[n - l];
      out[l] = avail > 1e-12 ? re[l] / N / Math.sqrt(avail) : 0;
    }
    return out;
  }
  const pow2 = (x) => Math.pow(2, Math.round(Math.log2(x)));

  /** FFT magnitude + flatness of one window (size follows the sample rate) */
  function frameSpectrum(frame, sr, Ns, out, q) {
    q = q || 1;
    const N = Ns;
    const re = new Float64Array(N), im = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += frame[i] || 0;
    mean /= N;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = ((frame[i] || 0) - mean) * w; }
    fft(re, im);
    const half = N / 2;
    const mag = new Float64Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    /* Band energies with partial-bin weighting: bands must not shift when the
       FFT resolution changes with the sample rate. */
    const be = new Float64Array(N_BANDS);
    const binHz = sr / N;
    for (let k = 2; k < half; k++) {
      const lo = k * binHz * q, hi = lo + binHz * q, p = mag[k] * mag[k];   // frequency axis scaled
      for (let b = 0; b < N_BANDS; b++) {
        const ov = Math.min(hi, BANDS[b + 1]) - Math.max(lo, BANDS[b]);
        if (ov > 0) be[b] += p * (ov / (binHz * q));
      }
    }
    /* Flatness is measured only up to 8 kHz: above that the available bandwidth
       depends on the sample rate, which would make the feature drift with it. */
    const kCap = Math.min(half - 1, Math.floor(8000 / binHz));
    let mx = 1e-12;
    for (let k = 2; k <= kCap; k++) if (mag[k] > mx) mx = mag[k];
    let logsum = 0, sum = 0, cnt = 0;
    for (let k = 2; k <= kCap; k++) { const v = mag[k] / mx + 1e-4; logsum += Math.log(v); sum += v; cnt++; }
    out.be = be; out.flat = Math.exp(logsum / (cnt || 1)) / ((sum / (cnt || 1)) || 1);
    return out;
  }

  /* ---------------------------------------------------------------- analyse */
  const SR0 = 22050;              // canonical analysis rate (matches the templates)
  const REFERENCE_F0 = 560;       // Hz: the pitch every spectrum is normalised to

  /** Resample to SR0 so fingerprints do not depend on the recording rate.
      Browsers hand us 44.1 or 48 kHz; the reference set is built at 22.05 kHz. */
  function resampleToCanonical(samples, sr) {
    if (Math.abs(sr - SR0) < 1) return { x: samples, sr: sr };
    let src = samples, s = sr;
    if (s > SR0) {                                // anti-alias before decimating
      /* 49-tap windowed-sinc low-pass. A gentle one-pole is not enough here:
         above-band hiss folds down and wrecks the spectral-flatness feature. */
      const fc = 9500, TAPS = 49, M = (TAPS - 1) / 2;
      const h = new Float64Array(TAPS);
      let sum = 0;
      for (let i = 0; i < TAPS; i++) {
        const n = i - M;
        const x = 2 * fc / s;
        const sinc = n === 0 ? x : Math.sin(Math.PI * x * n) / (Math.PI * n);
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1));   // Hann
        h[i] = sinc * w;
        sum += h[i];
      }
      for (let i = 0; i < TAPS; i++) h[i] /= sum;
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) {
        let acc = 0;
        for (let k = 0; k < TAPS; k++) {
          const j = i - M + k;
          if (j >= 0 && j < src.length) acc += src[j] * h[k];
        }
        out[i] = acc;
      }
      src = out;
    }
    const ratio = s / SR0;
    const n = Math.floor(src.length / ratio);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), u = pos - i0;
      const a = src[i0] || 0, b = src[i0 + 1] || a;
      y[i] = a * (1 - u) + b * u;
    }
    return { x: y, sr: SR0 };
  }

  function analyze(samples, sr, opts) {
    opts = opts || {};
    const rs = resampleToCanonical(samples, sr);
    samples = rs.x; sr = rs.sr;
    const HOP = Math.max(64, Math.round(0.008 * sr));
    const Ns = pow2(Math.min(2048, Math.max(256, 0.023 * sr)));   // ~23 ms windows
    const W = pow2(Math.min(8192, Math.max(512, 0.09 * sr)));     // ~90 ms pitch windows
    const nFrames = Math.max(1, Math.floor((samples.length - Ns) / HOP) + 1);
    const rms = new Float64Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0;
      const off = f * HOP;
      for (let i = 0; i < Ns; i++) { const v = samples[off + i] || 0; s += v * v; }
      rms[f] = Math.sqrt(s / Ns);
    }
    let peak = 1e-9;
    for (let f = 0; f < nFrames; f++) if (rms[f] > peak) peak = rms[f];
    const lo = peak * 0.10, hi = peak * 0.30;
    let a = -1, b = -1;
    for (let f = 0; f < nFrames; f++) if (rms[f] > lo) { a = f; break; }
    for (let f = nFrames - 1; f >= 0; f--) if (rms[f] > lo) { b = f; break; }
    if (a < 0 || b <= a) {
      return { feat: new Float64Array(FEATURES.length), ok: false, reason: 'too quiet',
               meta: { durSec: samples.length / sr, peak } };
    }
    const durSec = (b - a + 1) * HOP / sr;
    const voiced = [];
    for (let f = a; f <= b; f++) if (rms[f] > hi) voiced.push(f);

    /* --- pitch: FFT autocorrelation on a capped subset of the loud frames --- */
    /* F0 search window: the codec's voices live between ~330 Hz (a low falling
       'o') and ~1080 Hz (a high rising 'y'). Searching wider invites octave
       errors and, worse, lets a 26 Hz purr pull the estimate onto its own
       harmonics — which used to swamp the tone that carries the meaning. */
    const minLag = Math.max(2, Math.floor(sr / 1250)), maxLag = Math.ceil(sr / 330);
    const f0 = new Float64Array(b - a + 1).fill(NaN), acPeak = new Float64Array(b - a + 1).fill(NaN);
    const bufA = new Float64Array(W), acBuf = new Float64Array(Math.min(maxLag + 2, W / 2 - 1));
    /* Autocorrelation runs on a band-passed signal: high-passed at 220 Hz to
       take the purr out of the pitch signal, low-passed to 2.5 kHz so the
       estimate does not depend on how many harmonics fit under Nyquist (the
       same meow read at 16 kHz and 48 kHz must land on the same track). */
    const lp = new Float64Array(samples.length);
    {
      const a = Math.exp(-2 * Math.PI * 2500 / sr), b0 = 1 - a;
      const ah = Math.exp(-2 * Math.PI * 300 / sr);
      let x1 = 0, x2 = 0, h1 = 0, h2 = 0, hPrev = 0, prev = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i] || 0;
        h1 = ah * (h1 + v - prev); prev = v;   // one-pole high-pass
        h2 = ah * (h2 + h1 - hPrev); hPrev = h1;   // second stage (12 dB/oct)
        const s = h2;
        x1 = s * b0 + x1 * a;
        x2 = x1 * b0 + x2 * a;
        lp[i] = x2;
      }
    }
    let vmin = 1e9, vmax = 0;
    const loud = [];
    for (let f = a; f <= b; f++) if (rms[f] > hi) loud.push(f);
    const MAXF = 48;
    const stride = Math.max(1, Math.ceil(loud.length / MAXF));
    for (let li = 0; li < loud.length; li += stride) {
      const f = loud[li];
      const off = f * HOP;
      for (let i = 0; i < W; i++) bufA[i] = (off + i < lp.length) ? lp[off + i] : 0;
      acf(bufA, acBuf);
      const hiLag = Math.min(maxLag, acBuf.length - 2);
      let best = 0, bestLag = 0;
      for (let lag = minLag; lag <= hiLag; lag++) if (acBuf[lag] > best) { best = acBuf[lag]; bestLag = lag; }
      // take the FIRST strong peak: the global max is often period 2 (an octave low)
      let firstPeak = 0;
      const thr = Math.max(0.30, 0.72 * best);
      for (let l = minLag + 1; l < hiLag; l++) {
        if (acBuf[l] > thr && acBuf[l] >= acBuf[l - 1] && acBuf[l] > acBuf[l + 1]) { firstPeak = l; break; }
      }
      if (firstPeak) bestLag = firstPeak;
      if (bestLag > minLag * 1.7) {
        const halfLag = Math.round(bestLag / 2);
        if (acBuf[halfLag] > 0.7 * acBuf[bestLag]) bestLag = halfLag;
      }
      /* Parabolic refinement around the chosen lag. It has to use the peak AT
         that lag (not the global maximum) and must stay bracketed, otherwise
         the estimate can fly off to nonsense values. */
      let lag = bestLag;
      const s0 = acBuf[lag];
      if (s0 > 0.28 && lag > minLag && lag < hiLag) {
        const s1 = acBuf[lag - 1], s2 = acBuf[lag + 1];
        const den = s1 - 2 * s0 + s2;                       // < 0 at a true peak
        if (den < -1e-9) lag = lag + Math.max(-0.5, Math.min(0.5, 0.5 * (s1 - s2) / -den));
      }
      if (s0 > 0.28) {
        const hz = sr / lag;
        if (hz >= 300 && hz <= 1400) {
          f0[f - a] = hz; acPeak[f - a] = s0;
          vmin = Math.min(vmin, hz); vmax = Math.max(vmax, hz);
        }
      }
    }

    /* --- contour: 5 points over the loud core, median filtered --- */
    const idx = [];
    for (let i = 0; i < f0.length; i++) if (!isNaN(f0[i]) && rms[a + i] > 0.5 * peak) idx.push(i);
    /* Voicing = "a periodic peak was actually found", not "the sound is loud".
       A hiss is loud and aperiodic; this feature is what tells them apart. */
    let voicedFrames = 0;
    for (let i = 0; i < f0.length; i++) if (!isNaN(acPeak[i]) && acPeak[i] > 0.35) voicedFrames++;
    const contour = new Float64Array(5);
    let f0med = 0, f0Range = 0, harmonicity = 0;
    if (idx.length >= 3) {
      const vals = idx.map(i => f0[i]).sort((x, y) => x - y);
      f0med = vals[Math.floor(vals.length / 2)];
      const p10 = vals[Math.floor(vals.length * 0.1)], p90 = vals[Math.floor(vals.length * 0.9)];
      f0Range = Math.min(24, 12 * Math.log2(p90 / Math.max(1, p10)));
      harmonicity = idx.map(i => acPeak[i]).sort((x, y) => x - y)[Math.floor(idx.length / 2)];
      let st = idx.map(i => 12 * Math.log2(f0[i] / f0med));
      st = st.map((v, i, ar) => {                       // median-of-3 in log space
        const w = [ar[Math.max(0, i - 1)], v, ar[Math.min(ar.length - 1, i + 1)]].sort((p, q) => p - q);
        return w[1];
      });
      for (let q = 0; q < 5; q++) {
        const pos = q / 4 * (st.length - 1);
        const i0 = Math.floor(pos), i1 = Math.min(st.length - 1, i0 + 1), u = pos - i0;
        contour[q] = st[i0] * (1 - u) + st[i1] * u;
      }
    }

    /* --- spectrum: band shares + brightness over the whole meow ---
       The frequency axis is rescaled so that the meow is compared as if it had
       been produced at REFERENCE_F0. A deeper voice (a human imitating a cat, a
       big tom) has both a lower pitch and lower formants, so one scale factor
       lines its whole spectrum back up with the reference set. */
    const q = opts.pitchNormalize === false ? 1
      : (f0med > 60 ? Math.max(0.45, Math.min(2.2, REFERENCE_F0 / f0med)) : 1);
    const beAcc = new Float64Array(N_BANDS);
    let flatAcc = 0, centAcc = 0, centW = 0, nf = 0;
    const tmp = {};
    const step = Math.max(1, Math.floor((b - a) / 24));
    for (let f = a; f <= b; f += step) {
      frameSpectrum(samples.subarray(f * HOP, f * HOP + Ns), sr, Ns, tmp, q);
      for (let k = 0; k < N_BANDS; k++) beAcc[k] += tmp.be[k];
      flatAcc += tmp.flat; nf++;
      const binHz = sr / Ns;
      let num = 0, den = 0;
      for (let k = 2; k < Ns / 2; k++) { const p = (tmp.be[0] * 0 + 1) * 0 + 0; num += 0; den += 0; }
      // (centroid from the band shares: cheap and sample-rate independent)
      let tot = 0; for (let k = 0; k < N_BANDS; k++) tot += tmp.be[k];
      let cnum = 0;
      for (let k = 0; k < N_BANDS; k++) cnum += tmp.be[k] * Math.sqrt(BANDS[k] * BANDS[k + 1]);
      if (tot > 0) { centAcc += cnum / tot; centW++; }
    }
    if (nf) { for (let k = 0; k < N_BANDS; k++) beAcc[k] /= nf; flatAcc /= nf; }
    let tot = 0;
    for (let k = 0; k < N_BANDS; k++) tot += beAcc[k];
    const braw = [];
    for (let k = 0; k < N_BANDS; k++) braw.push(Math.log((beAcc[k] / (tot + 1e-12) + 1e-4) / 1e-4));
    /* de-tilt: remove the straight-line log-frequency trend. Breath noise and mic
       colouring shift the whole slope; vowel identity lives in what is left. */
    const xs = [], ys = braw;
    for (let k = 0; k < N_BANDS; k++) xs.push(Math.log(Math.sqrt(BANDS[k] * BANDS[k + 1])));
    let mx = 0, my = 0;
    for (let k = 0; k < N_BANDS; k++) { mx += xs[k] / N_BANDS; my += ys[k] / N_BANDS; }
    let num = 0, den = 0;
    for (let k = 0; k < N_BANDS; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) * (xs[k] - mx); }
    const tilt = den > 1e-9 ? num / den : 0;
    const bnorm = [];
    for (let k = 0; k < N_BANDS; k++) bnorm.push(ys[k] - (my + tilt * (xs[k] - mx)));
    const centroid = Math.log(Math.max(150, centW ? centAcc / centW : 800));

    /* --- rumble: 18-45 Hz share of a long spectrum = the purr engine --- */
    let rumble = 0;
    {
      const L = pow2(Math.min(16384, Math.max(4096, 0.4 * sr)));
      const center = Math.min(samples.length - 1, Math.round(((a + b) / 2) * HOP));
      const start = Math.max(0, Math.min(samples.length - L, center - L / 2));
      const re = new Float64Array(L), im = new Float64Array(L);
      for (let i = 0; i < L; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / L);
        re[i] = (samples[start + i] || 0) * w;
      }
      fft(re, im);
      const binHz = sr / L;
      let low = 0, all = 0;
      for (let k = 1; k < L / 2; k++) {
        const hz = k * binHz;
        if (hz > 5400) break;
        const p = re[k] * re[k] + im[k] * im[k];
        all += p;
        if (hz >= 18 && hz <= 45) low += p;
      }
      rumble = Math.min(2, 14 * (low / (all + 1e-12)));
    }

    /* --- flutter: 15-40 Hz modulation of the envelope --- */
    let modul = 0;
    const seg = [];
    for (let f = a; f <= b; f++) seg.push(rms[f]);
    if (seg.length > 10) {
      let mean = 0; for (const v of seg) mean += v; mean /= seg.length;
      const frameRate = sr / HOP;
      let mbest = 0;
      for (let hz = 14; hz <= 42; hz += 1) {
        let cr = 0, ci = 0;
        for (let i = 0; i < seg.length; i++) {
          const ph = 2 * Math.PI * hz * i / frameRate;
          cr += (seg[i] - mean) * Math.cos(ph); ci += (seg[i] - mean) * Math.sin(ph);
        }
        mbest = Math.max(mbest, Math.hypot(cr, ci) / (seg.length * mean + 1e-9));
      }
      modul = Math.min(1.5, mbest * 4);
    }

    /* --- shape: energy arrival times (robust; a single loud frame cannot swing it) --- */
    const span = Math.max(1, b - a);
    let eTot = 0;
    for (let f = a; f <= b; f++) eTot += rms[f] * rms[f];
    let acc = 0, t50 = 0.5, t90 = 0.9;
    for (let f = a; f <= b; f++) {
      acc += rms[f] * rms[f];
      if (!t50done && acc >= 0.5 * eTot) { var t50done = true; t50 = (f - a) / span; }
      if (acc >= 0.9 * eTot) { t90 = (f - a) / span; break; }
    }

    const feat = [
      contour[0], contour[1], contour[2], contour[3], contour[4],
      f0Range, Math.log(Math.max(80, f0med || 400)), Math.log(Math.max(0.05, durSec)),
      voicedFrames / Math.max(1, f0.length),
      isNaN(harmonicity) ? 0 : harmonicity, flatAcc,
      rumble, modul, t50, t90, centroid, tilt,
    ].concat(bnorm);
    for (let d = 0; d < feat.length; d++) if (!isFinite(feat[d])) feat[d] = 0;
    return {
      feat: Float64Array.from(feat), ok: true,
      meta: {
        durSec, f0medHz: Math.round(f0med), f0minHz: vmin < 1e9 ? Math.round(vmin) : 0, f0maxHz: Math.round(vmax),
        f0RangeSt: f0Range, rumble, modul, flatness: flatAcc, harmonicity, centroidHz: Math.round(Math.exp(centroid)),
        pitchNorm: q,
        voicedFrac: feat[8], loudFrac: voiced.length / Math.max(1, b - a + 1), peak, contour: Array.from(contour),
      },
    };
  }

  /** level change, hiss and a one-pole muffling: what a real microphone adds */
  function perturb(x, sr, v, seed) {
    let ns = (1234567 + 7919 * (seed || 0)) >>> 0;
    const a = v.lp ? Math.exp(-2 * Math.PI * v.lp / sr) : 0;
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      ns = (ns * 1103515245 + 12345) & 0x7fffffff;
      const w = (ns / 0x3fffffff) - 1;
      let s = x[i] * (v.gain != null ? v.gain : 1) + w * (v.noise || 0);
      if (a) { y = s * (1 - a) + y * a; s = y; }
      x[i] = s;
    }
    return x;
  }

  /* ------------------------------------------------- per-class acoustic model */
  /**
   * Template matching (nearest variant) wastes the fact that we have MANY
   * renderings per meow. Treat each meow as a small Gaussian in feature space:
   * its own mean and per-dimension spread, measured from the variants. Then
   * "which meow is this?" is a Mahalanobis comparison, so a dimension that
   * naturally wanders for one meow stops shouting for that meow only.
   *   score = sum_d  w_d * [ (x-mu)^2 / var + ln var ]
   * Lower is better. The ln var term is the volume penalty, it is what stops a
   * sloppy class from swallowing everything.
   */
  function buildClasses(items, stats) {
    const f = FEATURES.length;
    const byClass = new Map();
    for (const it of items) {
      const k = it.tokens.join(' ');
      if (!byClass.has(k)) byClass.set(k, []);
      byClass.get(k).push(it.feat);
    }
    const classes = [];
    for (const [k, feats] of byClass) {
      const mean = new Float64Array(f), varr = new Float64Array(f);
      for (const x of feats) for (let d = 0; d < f; d++) mean[d] += x[d] / feats.length;
      for (const x of feats) for (let d = 0; d < f; d++) varr[d] += Math.pow(x[d] - mean[d], 2) / feats.length;
      for (let d = 0; d < f; d++) varr[d] = Math.max(varr[d], 1e-4);
      classes.push({ tokens: k.split(' '), mean, var: varr, n: feats.length });
    }
    return classes;
  }

  /** Gaussian score of one fingerprint against one class (lower = better fit) */
  function gaussScore(feat, cls, weights, mean0, std0) {
    let s = 0;
    for (let d = 0; d < feat.length; d++) {
      const w = weights[FEATURES[d]] != null ? weights[FEATURES[d]] : 1;
      const v = cls.var[d];
      const dz = feat[d] - cls.mean[d];
      s += w * (dz * dz / v + Math.log(v));
    }
    return s;
  }

  /** Rank every class by Gaussian score, with softmax probabilities. */
  function rankClasses(feat, templates, limit) {
    const classes = templates.classes;
    if (!classes || !classes.length) return rankUnique(feat, templates, limit);
    const w = templates.stats.weights;
    const scored = classes.map(c => ({ it: c, s: gaussScore(feat, c, w, templates.stats.mean, templates.stats.std) }));
    scored.sort((a, b) => a.s - b.s);
    const T = 2;                                     // score units -> probability temperature
    const out = scored.slice(0, limit || 6).map(x => ({
      tokens: x.it.tokens, seq: x.it.tokens.join(' '), score: x.s, prob: Math.exp(-x.s / T),
    }));
    let psum = 0;
    for (const o of out) psum += o.prob;
    for (const o of out) o.prob /= (psum || 1);
    const best = scored[0] ? scored[0].s : 1e9;
    const second = scored[1] ? scored[1].s : best + 1;
    const margin = Math.max(0, Math.min(1, (second - best) / 12));
    const fit = Math.max(0, Math.min(1, 1 - best / (8 * FEATURES.length)));
    return {
      ranked: out, bestScore: best, margin, fit,
      confidence: Math.max(0, Math.min(1, 0.5 * fit + 0.5 * margin)),
    };
  }

  /* ------------------------------------------------------------- segmenting */
  /**
   * Split a recording into individual meows.
   * Cats (and people imitating them) leave a quiet gap between meows and the
   * matcher works far better on one meow at a time, so this is the first step
   * of every listen: gaps in the envelope become cut points.
   */
  function segment(samples, sr, opts) {
    opts = opts || {};
    const rs = resampleToCanonical(samples, sr);
    const x = rs.x, s0 = rs.sr;
    const HOP = Math.round(0.008 * s0), WIN = Math.round(0.016 * s0);
    const nF = Math.max(1, Math.floor((x.length - WIN) / HOP) + 1);
    const rms = new Float64Array(nF);
    for (let f = 0; f < nF; f++) {
      let e = 0;
      for (let i = 0; i < WIN; i++) { const v = x[f * HOP + i] || 0; e += v * v; }
      rms[f] = Math.sqrt(e / WIN);
    }
    let peak = 1e-9;
    for (let f = 0; f < nF; f++) if (rms[f] > peak) peak = rms[f];
    if (peak < (opts.floor || 0.0035)) return { meows: [], peak, sr: s0, x, rms, hop: HOP };

    const thr = Math.max(peak * (opts.thrRatio || 0.12), peak * 0.06);
    const minFrames = Math.max(2, Math.round((opts.minDur || 0.07) * s0 / HOP));   // reject clicks
    const gapFrames = Math.max(1, Math.round((opts.minGap || 0.045) * s0 / HOP));
    const runs = [];
    let start = -1, quiet = 0;
    for (let f = 0; f < nF; f++) {
      if (rms[f] >= thr) {
        if (start < 0) start = f;
        quiet = 0;
      } else if (start >= 0) {
        quiet++;
        if (quiet >= gapFrames) {
          const end = f - quiet;
          if (end - start + 1 >= minFrames) runs.push([start, end]);
          start = -1; quiet = 0;
        }
      }
    }
    if (start >= 0 && nF - 1 - start + 1 >= minFrames) runs.push([start, nF - 1]);

    const pad = Math.round(0.02 * s0);
    return {
      meows: runs.map(([a, b]) => ({
        a: Math.max(0, a * HOP - pad), b: Math.min(x.length, b * HOP + WIN + pad),
        samples: x.subarray(Math.max(0, a * HOP - pad), Math.min(x.length, b * HOP + WIN + pad)),
        durSec: (b - a + 1) * HOP / s0,
      })),
      peak, sr: s0, x, rms, hop: HOP,
    };
  }

  /* --------------------------------------------------------------- templates */
  function buildTemplates(seqs, renderFn, opts) {
    opts = opts || {};
    const sr = opts.sr || 22050;
    /* Voice + microphone variation. The reference set has to cover the same
       conditions the microphone will throw at us (level, hiss, muffling),
       otherwise the matcher spends its distance budget on the recording chain. */
    const variants = opts.variants || [
      { voicePitch: 1.00, voiceSpeed: 1.00, gap: 0.06, noiseMul: 1.00, formantMul: 1.00, gain: 1.00, noise: 0.006, lp: 0 },
      { voicePitch: 0.84, voiceSpeed: 1.12, gap: 0.04, noiseMul: 1.10, formantMul: 0.96, gain: 0.55, noise: 0.012, lp: 2600 },
      { voicePitch: 1.18, voiceSpeed: 0.90, gap: 0.09, noiseMul: 0.90, formantMul: 1.04, gain: 1.35, noise: 0.004, lp: 0 },
      { voicePitch: 0.92, voiceSpeed: 0.96, gap: 0.12, noiseMul: 1.25, formantMul: 1.00, gain: 0.80, noise: 0.020, lp: 3400 },
      { voicePitch: 1.10, voiceSpeed: 1.22, gap: 0.03, noiseMul: 0.95, formantMul: 1.03, gain: 1.10, noise: 0.010, lp: 4400 },
      { voicePitch: 1.00, voiceSpeed: 1.38, gap: 0.06, noiseMul: 1.15, formantMul: 0.98, gain: 0.70, noise: 0.008, lp: 3000 },
      { voicePitch: 0.96, voiceSpeed: 1.05, gap: 0.08, noiseMul: 1.35, formantMul: 0.97, gain: 0.45, noise: 0.024, lp: 2200 },
      { voicePitch: 1.24, voiceSpeed: 1.00, gap: 0.05, noiseMul: 1.00, formantMul: 1.05, gain: 1.40, noise: 0.014, lp: 3800 }, 
      { voicePitch: 0.78, voiceSpeed: 1.30, gap: 0.10, noiseMul: 1.05, formantMul: 0.95, gain: 0.62, noise: 0.016, lp: 4800 },
      { voicePitch: 1.06, voiceSpeed: 0.85, gap: 0.02, noiseMul: 1.20, formantMul: 1.02, gain: 1.25, noise: 0.007, lp: 0 },
      { voicePitch: 0.90, voiceSpeed: 1.18, gap: 0.07, noiseMul: 0.92, formantMul: 1.01, gain: 0.90, noise: 0.018, lp: 2000 },
      { voicePitch: 1.15, voiceSpeed: 1.08, gap: 0.11, noiseMul: 1.10, formantMul: 0.99, gain: 0.50, noise: 0.005, lp: 5600 },
      { voicePitch: 1.02, voiceSpeed: 0.94, gap: 0.05, noiseMul: 1.30, formantMul: 1.06, gain: 1.30, noise: 0.022, lp: 3200 },
    ];
    const items = [];
    for (const s of seqs) {
      const descs = g.MEOW_ENGINE.describeTokens(s.tokens);
      if (!descs.length) continue;
      variants.forEach((v, vi) => {
        const d2 = descs.map(d => Object.assign({}, d, {
          noise: (d.noise || 0) * v.noiseMul + 0.004,
          formantScale: (d.formantScale || 1) * v.formantMul,
        }));
        const samples = renderFn(d2, { sr, voicePitch: v.voicePitch, voiceSpeed: v.voiceSpeed, gap: v.gap, qScale: v.qScale || 1 });
        perturb(samples, sr, v, vi);
        const an = analyze(samples, sr);
        if (an.ok) items.push({ tokens: s.tokens, text: s.text, feat: an.feat, meta: an.meta, variant: vi });
      });
    }
    const f = FEATURES.length;
    const stats = { mean: new Float64Array(f), std: new Float64Array(f), overallStd: new Float64Array(f),
                    weights: Object.assign({}, DEFAULT_W) };
    for (const it of items) for (let d = 0; d < f; d++) stats.mean[d] += it.feat[d];
    for (let d = 0; d < f; d++) stats.mean[d] /= Math.max(1, items.length);
    for (const it of items) for (let d = 0; d < f; d++) { const v = it.feat[d] - stats.mean[d]; stats.overallStd[d] += v * v; }
    for (let d = 0; d < f; d++) stats.overallStd[d] = Math.sqrt(stats.overallStd[d] / Math.max(1, items.length));

    /* Scale every dimension by how much it wanders WITHIN one meow (across the
       augmentation variants). That is the noise floor of that dimension, so after
       dividing by it a distance of 1 means "one typical variation away". */
    const byClass = new Map();
    for (const it of items) {
      const k = it.tokens.join(' ');
      if (!byClass.has(k)) byClass.set(k, []);
      byClass.get(k).push(it);
    }
    const withinVar = new Float64Array(f);
    let classes = 0;
    for (const [, arr] of byClass) {
      if (arr.length < 2) continue;
      classes++;
      for (let d = 0; d < f; d++) {
        let mu = 0;
        for (const it of arr) mu += it.feat[d];
        mu /= arr.length;
        let v = 0;
        for (const it of arr) { const t = it.feat[d] - mu; v += t * t; }
        withinVar[d] += v / arr.length;
      }
    }
    for (let d = 0; d < f; d++) {
      const wd = Math.sqrt(withinVar[d] / Math.max(1, classes));
      stats.std[d] = Math.max(wd, 0.20 * stats.overallStd[d], 0.02);
    }
    stats.classes = classes;
    stats.n = items.length;

    /* Reliability: how far apart class means sit relative to the spread inside a
       class, per dimension. Squeezed into [0.35, 2.5] so no dimension can veto. */
    const classMeans = [];
    for (const arr of byClass.values()) {
      const m = new Float64Array(f);
      for (const it of arr) for (let d = 0; d < f; d++) m[d] += it.feat[d] / arr.length;
      classMeans.push(m);
    }
    for (let d = 0; d < f; d++) {
      let mu = 0;
      for (const m of classMeans) mu += m[d];
      mu /= Math.max(1, classMeans.length);
      let btw = 0;
      for (const m of classMeans) btw += (m[d] - mu) * (m[d] - mu);
      btw /= Math.max(1, classMeans.length);
      const wtn = Math.max(1e-9, withinVar[d] / Math.max(1, classes));
      const fisher = Math.sqrt(btw / wtn);
      const prior = DEFAULT_W[FEATURES[d]] != null ? DEFAULT_W[FEATURES[d]] : 1;
      stats.weights[FEATURES[d]] = Math.max(0.35, Math.min(2.5, prior * (0.5 + 0.5 * Math.min(2, fisher / 2))));
    }
    let acc = 0, cnt = 0;
    const step = Math.max(1, Math.floor(items.length / 120));
    for (let i = 0; i < items.length; i += step) for (let j = i + step; j < items.length; j += step) { acc += dist(items[i].feat, items[j].feat, stats); cnt++; }
    stats.typicalDist = cnt ? acc / cnt : 3;
    return { items, stats, sr, classes: buildClasses(items, stats) };
  }

  function dist(a, b, stats) {
    const w = stats.weights, s = stats.std, m = stats.mean;
    let sum = 0;
    for (let d = 0; d < a.length; d++) {
      const za = (a[d] - m[d]) / s[d], zb = (b[d] - m[d]) / s[d];
      const dz = za - zb;
      let wd = w[FEATURES[d]];
      if (wd == null) wd = 1;
      sum += wd * dz * dz;
    }
    return Math.sqrt(sum);
  }

  function rank(feat, templates, limit) {
    const { items, stats } = templates;
    const scored = items.map(it => ({ it, d: dist(feat, it.feat, stats) }));
    scored.sort((x, y) => x.d - y.d);
    const best = scored[0] ? scored[0].d : 99, second = scored[1] ? scored[1].d : 99;
    const T = Math.max(0.8, stats.typicalDist * 0.55);
    const out = scored.slice(0, limit || 5).map(s => ({
      seq: s.it.text || s.it.tokens.join(' '), tokens: s.it.tokens, dist: s.d, prob: Math.exp(-s.d / T),
    }));
    const psum = out.reduce((a, x) => a + x.prob, 0) || 1;
    out.forEach(x => { x.prob /= psum; });
    const margin = second > 0 ? Math.max(0, (second - best) / (second + 1e-9)) : 1;
    const fit = 1 / (1 + best / Math.max(0.5, stats.typicalDist));
    return { ranked: out, bestDist: best, secondDist: second, margin, fit, stats };
  }

  /** Collapse augmentation variants so several candidates for one meow count once. */
  function rankUnique(feat, templates, limit) {
    const r = rank(feat, templates, templates.items.length);
    const seen = new Map();
    for (const c of r.ranked) {
      const key = c.tokens.join(' ');
      if (!seen.has(key)) seen.set(key, Object.assign({}, c, { prob: 0, dSum: 0, n: 0 }));
      const s = seen.get(key);
      s.prob += c.prob; s.dSum += c.dist; s.n++;
    }
    const list = [...seen.values()].map(s => Object.assign(s, { dist: s.dSum / s.n }))
      .sort((a, b) => a.dist - b.dist).slice(0, limit || 6);
    const T = Math.max(0.8, r.stats.typicalDist * 0.55);
    let psum = 0;
    list.forEach(c => { c.prob = Math.exp(-c.dist / T); psum += c.prob; });
    list.forEach(c => { c.prob /= psum || 1; });
    const confidence = list.length
      ? Math.max(0, Math.min(1, (0.55 * r.fit + 0.45 * Math.min(1, r.margin * 2.2)) * (0.6 + 0.4 * list[0].prob)))
      : 0;
    return { ranked: list, bestDist: r.bestDist, secondDist: r.secondDist, margin: r.margin, fit: r.fit, confidence, stats: r.stats };
  }

  /** Rehydrate fingerprints produced by tools/build-templates.mjs */
  function fromJSON(obj) {
    const items = obj.items.map(it => ({ tokens: it.t, text: it.x, variant: it.v, feat: Float64Array.from(it.d) }));
    const stats = {
      mean: Float64Array.from(obj.mean), std: Float64Array.from(obj.std),
      overallStd: obj.overallStd ? Float64Array.from(obj.overallStd) : Float64Array.from(obj.std),
      weights: Object.assign({}, DEFAULT_W, obj.weights || {}),
      typicalDist: obj.typicalDist || 5, n: items.length,
    };
    let classes = null;
    if (obj.classes) {
      classes = obj.classes.map(c => ({
        tokens: c.t, mean: Float64Array.from(c.m), var: Float64Array.from(c.v), n: c.n,
      }));
    } else {
      classes = buildClasses(items, stats);          // older payloads still work
    }
    return {
      items, stats, classes,
      sr: obj.sr,
      items,
    };
  }

  g.MEOW_MATCH = { FEATURES, N_BANDS, BANDS, DEFAULT_W, SR0, FEATURE_COUNT: FEATURES.length,
    analyze, segment, resampleToCanonical, buildTemplates, dist, rank, rankUnique, rankClasses,
    buildClasses, gaussScore, fft, acf, fromJSON, perturb };
})(typeof globalThis !== 'undefined' ? globalThis : window);
