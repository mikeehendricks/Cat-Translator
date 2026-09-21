/* ============================================================================
   cat-translator :: tokens.js
   The 4-dimensional meow parameter space + a stable synthesis descriptor per
   token. Every token the lexicon can emit has a deterministic acoustic
   signature, which is what makes the reverse direction (audio -> text) work.
   ========================================================================== */
(function (g) {
  'use strict';

  /* [F1,F2,F3] in Hz, cat-ish (human vowels x1.5). Two constraints shaped this
     table: the vowels have to be spread wide, and the formants have to be BROAD,
     because a cat voice carries harmonics only ~500 Hz apart — a narrow formant
     can be missed by every harmonic and then the vowel is simply not in the
     spectrum. The spreads below survive that. */
  const VOWELS = {
    a: [1000, 1600, 2900],   // central-low
    e: [700, 2000, 3050],    // front-mid
    i: [450, 2500, 3300],    // front-high
    o: [750, 1100, 2700],    // back-mid
    u: [450, 800, 2550],     // back-high
    y: [550, 1550, 3100],    // front-high rounded: between i and u
  };

  const TONES = {                  // semitones: [start, peak, end] relative to base
    flat: [0, 0, 0],
    rise: [-3, 0, 9],
    fall: [7, 0, -8],
    arch: [-4, 8, 1],
    dip: [4, -7, 3],
  };

  const ONSET = {
    none: { dur: 0.55, chatter: 0 },
    m:    { dur: 1.0,  chatter: 0 },
    prr:  { dur: 1.55, chatter: 0 },
    h:    { dur: 0.85, chatter: 0 },
  };

  const LENGTH = { short: 0.3, normal: 0.52, long: 0.95 };

  const SPECIALS = {
    purr:    { special: 'purr',    dur: 1.45, purr: 0.5,  glottal: 0.10, noise: 0.025, base: 300, rate: 26, breath: 0.35 },
    hiss:    { special: 'hiss',    dur: 0.95, purr: 0.05, glottal: 0.05, noise: 0.34,  base: 700, rate: 26, breath: 1.0 },
    chirp:   { special: 'chirp',   dur: 0.17, purr: 0,    glottal: 0.62, noise: 0.02,  base: 720, tone: [-2, 6, 18] },
    chatter: { special: 'chatter', dur: 0.38, purr: 0.1,  glottal: 0.30, noise: 0.05,  base: 660, flutter: 22 },
  };

  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); };

  /** Parse "onset-vowel-tone-length" => {onset, vowel, tone, length}. */
  function parseToken(tok) {
    if (SPECIALS[tok]) return { special: tok, raw: tok };
    const p = String(tok).split('-');
    if (p.length !== 4 || !VOWELS[p[1]] || !TONES[p[2]] || !LENGTH[p[3]]) return { unknown: true, raw: tok };
    return { onset: p[0], vowel: p[1], tone: p[2], length: p[3], raw: tok };
  }

  /** Full synthesis descriptor: everything synth.js / render.js need. */
  function describe(tok) {
    const p = parseToken(tok);
    if (p.unknown) return null;
    if (p.special) { const s = SPECIALS[p.special]; return Object.assign({ token: tok, tone: [0, 0, 0], formants: [800, 1400, 2800], formantScale: 1 }, s); }

    const o = ONSET[p.onset] || ONSET.m;
    const tone = TONES[p.tone];
    const dur = o.dur * LENGTH[p.length];
    const h = hash(tok);
    const base = 470 + (h % 200);                       // stable per-token pitch ~470-670 Hz
    /* Formants scale with the voice's own pitch, the way a bigger animal has both
       a deeper voice and a longer vocal tract. This keeps pitch-normalised
       spectra comparable between my meows, and matches real speakers. */
    const formantScale = (base / 560) * (0.95 + ((h >> 9) % 11) / 100);   // 0.95-1.05

    return {
      token: tok,
      onset: p.onset,
      vowel: p.vowel,
      toneName: p.tone,
      lengthName: p.length,
      tone,
      dur,
      base,
      formants: VOWELS[p.vowel],
      formantScale,
      glottal: 1 - 0.5 * (o.dur > 1 ? 1 : 0),
      noise: p.onset === 'h' ? 0.13 : 0.02,
      purr: p.onset === 'prr' ? 0.26 : 0,
      rate: 26,
      breath: 0.3,
      vibrato: p.tone === 'rise' ? 6 : 5,
      vibratoDepth: p.tone === 'rise' ? 0.045 : 0.022,
      special: null,
    };
  }

  /** Human-readable meow string: "my↑: purr me→" */
  const SYM = { flat: '', rise: '\u2191', fall: '\u2193', arch: '\u02c6', dip: '\u02cc' };
  const LSYM = { short: '\u00b7', normal: '', long: ':' };
  const ONSYM = { none: '', m: 'm', prr: 'prr', h: 'h' };

  function tokenToString(tok) {
    const p = parseToken(tok);
    if (p.unknown) return '?';
    if (p.special) return p.special;
    return (p.onset in ONSYM ? ONSYM[p.onset] : 'm') + p.vowel + SYM[p.tone] + LSYM[p.length];
  }

  const EMOJI = {
    purr: '\u{1F63A}', hiss: '\u{1F63E}', chirp: '\u{1F426}', chatter: '\u{1F43F}\uFE0F',
    flat: '\u2728', rise: '\u{1F4C8}', fall: '\u{1F4C9}', arch: '\u26A1', dip: '\u3030\uFE0F',
  };
  function tokenToGlyph(tok) {
    const p = parseToken(tok);
    if (p.unknown) return '\u2753';
    if (p.special) return EMOJI[p.special];
    return (p.onset in ONSYM ? ONSYM[p.onset] : 'm') + p.vowel + EMOJI[p.tone];
  }

  function tokensToString(tokens) { return tokens.map(tokenToString).join(' '); }
  function tokensToGlyphs(tokens) { return tokens.map(tokenToGlyph).join(' '); }
  function stringToTokens(str) {
    return String(str).trim().split(/\s+/).map(s => {
      const m = s.match(/^(prr|m|h)?([aeiouy])([\u2191\u2193\u02c6\u02cc]?)([:\u00b7]?)$/);
      if (m) {
        const tone = Object.keys(SYM).find(k => SYM[k] === (m[3] || '')) || 'flat';
        const len = m[4] === ':' ? 'long' : m[4] === '\u00b7' ? 'short' : 'normal';
        return (m[1] || 'none') + '-' + m[2] + '-' + tone + '-' + len;
      }
      return SPECIALS[s] ? s : null;
    }).filter(Boolean);
  }

  g.MEOW_TOKENS = { VOWELS, TONES, ONSET, LENGTH, SPECIALS, parseToken, describe, tokenToString, tokenToGlyph, tokensToString, tokensToGlyphs, stringToTokens, hash };
})(typeof globalThis !== 'undefined' ? globalThis : window);
