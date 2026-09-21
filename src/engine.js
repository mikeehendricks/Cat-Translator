/* ============================================================================
   cat-translator :: engine.js
   The codec.

     encode("i love you")  ->  { tokens, meow, gloss }     English -> Meownese
     decode(tokens)        ->  { text, confidence, ... }    Meownese -> English

   English is reduced to lowercase words (numbers become "count meows"), then a
   3-word -> 1-word greedy longest-match walks the lexicon.
   ========================================================================== */
(function (g) {
  'use strict';

  const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

  function normalize(text) {
    let t = String(text || '').toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/(\d+)/g, (m) => ' ' + (NUM[+m] || numWords(+m)) + ' ')
      .replace(/[^a-z' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // contract common negations into lexicon keys
    t = t.replace(/\bdo not\b|\bdoes not\b|\bdid not\b/g, "don't")
         .replace(/\bcannot\b|\bcan not\b/g, "can't")
         .replace(/\bwill not\b/g, "won't");
    return t;
  }

  function numWords(n) {
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    if (n < 20) return ['ten', 'eleven', 'twelve'][n - 10] || '';
    let s = '';
    if (n >= 100) { s += ones[Math.floor(n / 100)] + ' hundred '; n %= 100; }
    if (n >= 20) { s += ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'][Math.floor(n / 10)] + ' '; n %= 10; }
    return (s + (ones[n] || '')).trim();
  }

  /* ------------------------------------------------------------------ encode */
  function encode(text, lex, phr) {
    lex = lex || g.MEOW_LEXICON; phr = phr || g.MEOW_PHRASES;
    const norm = normalize(text);
    const words = norm ? norm.split(' ') : [];
    const tokens = [], notes = [];
    const maxP = Object.keys(phr).reduce((m, k) => Math.max(m, k.split(' ').length), 1);
    let i = 0;
    while (i < words.length) {
      let hit = false;
      for (let len = maxP; len >= 1 && !hit; len--) {
        if (i + len > words.length) continue;
        const key = words.slice(i, i + len).join(' ');
        const seq = (len > 1 ? phr[key] : null) || lex[key];
        if (seq) {
          const toks = seq.split(' ');
          tokens.push.apply(tokens, toks);
          notes.push({ text: key, tokens: toks });
          i += len;
          hit = true;
        }
      }
      if (!hit) { notes.push({ text: words[i], tokens: [], oov: true }); i += 1; }
    }
    return { text: String(text || ''), normalized: norm, words, tokens, notes, meow: g.MEOW_TOKENS.tokensToString(tokens), glyphs: g.MEOW_TOKENS.tokensToGlyphs(tokens) };
  }

  /* ------------------------------------------------------------------ decode */
  /** Build the token-sequence -> canonical-English reverse table. */
  function buildReverse(lex, phr) {
    lex = lex || g.MEOW_LEXICON; phr = phr || g.MEOW_PHRASES;
    const rev = new Map();
    let maxLen = 1;
    const add = (seq, en) => { if (!rev.has(seq)) rev.set(seq, en); maxLen = Math.max(maxLen, seq.split(' ').length); };
    const { CANON, PCANON } = g.MEOW_CANON;
    // canonical answers first (that is what the decoder is allowed to say)
    for (const seq in CANON) add(seq, CANON[seq]);
    for (const seq in PCANON) if (!rev.has(seq)) rev.set(seq, PCANON[seq]);
    let maxPhraseLen = 1;
    for (const seq in PCANON) maxPhraseLen = Math.max(maxPhraseLen, seq.split(' ').length);
    // words first, then phrases may not override (phrases are matched by the same token stream)
    return { rev, maxLen: Math.max(maxLen, maxPhraseLen) };
  }

  /**
   * tokens -> English. Longest-match over the reverse lexicon.
   * confidence = share of the *heard* tokens the lexicon could explain.
   */
  function decode(tokens, lex, phr, opts) {
    lex = lex || g.MEOW_LEXICON; phr = phr || g.MEOW_PHRASES;
    opts = opts || {};
    if (!tokens || !tokens.length) return { text: '', segments: [], confidence: 0, unmatched: [], unknown: [] };
    const { rev, maxLen } = buildReverse(lex, phr);
    const segments = [], unmatched = [], unknown = [];
    let i = 0;
    while (i < tokens.length) {
      let best = null;
      for (let len = Math.min(maxLen, tokens.length - i); len >= 1 && !best; len--) {
        const seq = tokens.slice(i, i + len).join(' ');
        const en = rev.get(seq);
        if (en) { best = { en, len, seq }; break; }
      }
      if (best) { segments.push({ en: best.en, tokens: tokens.slice(i, i + best.len) }); i += best.len; }
      else { unmatched.push(tokens[i]); if (/^(purr|hiss|chirp|chatter)$/.test(tokens[i]) || g.MEOW_TOKENS.parseToken(tokens[i]).unknown) unknown.push(tokens[i]); i += 1; }
    }
    // cosmetic: fold adjacent identical words ("very very" -> "very")
    const merged = [];
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last && last.en === seg.en) last.tokens = last.tokens.concat(seg.tokens);
      else merged.push(seg);
    }
    const text = merged.map(s => s.en).join(' ');
    const explained = tokens.length - unmatched.length;
    const conf = tokens.length ? explained / tokens.length : 0;
    const penalty = opts.penalty || 0;                    // e.g. weak acoustic match
    return {
      text, segments: merged, unmatched, unknown, tokens,
      confidence: Math.max(0, Math.min(1, conf * (1 - penalty))),
      meow: g.MEOW_TOKENS.tokensToString(tokens),
    };
  }

  /** token -> synthesis descriptor, with a per-session "voice profile" applied */
  function describeTokens(tokens, voice) {
    voice = voice || { pitch: 1, speed: 1, gruff: 1 };
    return tokens.map(t => {
      const d = g.MEOW_TOKENS.describe(t);
      if (!d) return null;
      const c = Object.assign({}, d);
      c.base = d.base * voice.pitch;
      c.formantScale = d.formantScale * voice.pitch;   // a deeper voice has lower formants too
      c.dur = d.dur * voice.speed;
      c.rate = d.rate * (0.85 + 0.3 * voice.gruff);
      return c;
    }).filter(Boolean);
  }

  g.MEOW_ENGINE = { normalize, encode, decode, describeTokens, buildReverse, NUM };
})(typeof globalThis !== 'undefined' ? globalThis : window);
