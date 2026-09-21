/* ============================================================================
   Design the meow codebook and generate src/lexicon.js.

   Both ends of this translator are ours, so which sound means which word is a
   design choice. Hand-assigning 150 token strings is how you end up with "you"
   and "give" differing by a single vowel and a matcher that cannot tell them
   apart. Instead this renders all 364 possible meows, measures their
   fingerprints, and picks the ~120 that sit farthest apart from each other
   (farthest-point sampling), then binds meanings to them.

   Each meaning keeps the tone and length of its original meow where possible,
   so the language keeps its feel (fall = no/bad, rise = question/urgency), and
   only vowel/onset are reassigned for distinctness.

   Inputs (frozen on first run):  tools/meanings.json, tools/phrases.json
   Output:                        src/lexicon.js
   ========================================================================== */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const needOldLexicon = !fs.existsSync(path.join(root, 'tools/meanings.json')) || !fs.existsSync(path.join(root, 'tools/phrases.json'));
const flow = ['src/tokens.js', 'src/engine.js', 'src/synth.js', 'src/match.js'];
if (needOldLexicon) flow.unshift('src/lexicon.js');
for (const f of flow) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const { MEOW_GROUPS: GRP, MEOW_MATCH: M, MEOW_SYNTH: S, MEOW_TOKENS: T, MEOW_ENGINE: E } = globalThis;

const ONSETS = ['m', 'prr', 'h', 'none'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'y'];
const TONES = ['flat', 'rise', 'fall', 'arch', 'dip'];
const LENGTHS = ['short', 'normal', 'long'];
const SPECIALS = ['purr', 'hiss', 'chirp', 'chatter'];
const NUMS = /^(zero|one|two|three|four|five|six|seven|eight|nine|ten)$/;
const SR = 22050;

/* ------------------------------------------------- 1. freeze the meanings */
const meaningsFile = path.join(root, 'tools/meanings.json');
const phrasesFile = path.join(root, 'tools/phrases.json');
let meanings, phrases;
if (fs.existsSync(meaningsFile) && fs.existsSync(phrasesFile)) {
  meanings = JSON.parse(fs.readFileSync(meaningsFile, 'utf8'));
  phrases = JSON.parse(fs.readFileSync(phrasesFile, 'utf8'));
} else {
  meanings = GRP.filter(g => g.kind === 'word' && !NUMS.test(g.canon)).map(g => {
    const first = g.seq.split(' ')[0];
    const special = (SPECIALS.indexOf(first) >= 0 && g.seq.split(' ').length === 1) ? first : null;
    const p = T.parseToken(first);
    return { canon: g.canon, aliases: g.aliases, tone: special ? 'special' : p.tone,
             len: special ? 'special' : p.length, special };
  });
  phrases = GRP.filter(g => g.kind === 'phrase').map(g => ({ canon: g.canon, aliases: g.aliases }));
  fs.writeFileSync(meaningsFile, JSON.stringify(meanings, null, 1));
  fs.writeFileSync(phrasesFile, JSON.stringify(phrases, null, 1));
  console.error(`froze ${meanings.length} meanings + ${phrases.length} phrases`);
}

/* --------------------------------------------------- 2. measure the sounds */
const allTokens = [];
for (const o of ONSETS) for (const v of VOWELS) for (const t of TONES) for (const l of LENGTHS) allTokens.push(`${o}-${v}-${t}-${l}`);
allTokens.push(...SPECIALS);
console.error(`rendering ${allTokens.length} candidate meows ...`);

function fingerprint(tok, variant) {
  const d = T.describe(tok);
  const dd = Object.assign({}, d, {
    noise: (d.noise || 0) * (variant ? variant.noiseMul : 1) + 0.004,
    formantScale: (d.formantScale || 1) * (variant ? variant.formantMul : 1),
  });
  const s = S.renderUtterance([dd], { sr: SR, voicePitch: variant ? variant.voicePitch : 1, voiceSpeed: variant ? variant.voiceSpeed : 1 });
  return M.analyze(s, SR);
}

const feats = new Map();
for (const tk of allTokens) feats.set(tk, fingerprint(tk).feat);

/* how far a dimension wanders when the same meow is spoken differently */
const dims = M.FEATURES.length;
const perDimStd = new Float64Array(dims);
{
  const VARIANTS = [
    { voicePitch: 0.86, voiceSpeed: 0.90, noiseMul: 0.90, formantMul: 0.96 },
    { voicePitch: 1.00, voiceSpeed: 1.00, noiseMul: 1.00, formantMul: 1.00 },
    { voicePitch: 1.16, voiceSpeed: 1.14, noiseMul: 1.15, formantMul: 1.04 },
  ];
  const probe = allTokens.filter((_, i) => i % 5 === 0);
  const vars = probe.map(tk => VARIANTS.map(v => fingerprint(tk, v).feat));
  let n = 0;
  for (const arr of vars) {
    if (arr.length < 2) continue;
    n++;
    for (let d = 0; d < dims; d++) {
      let mu = 0;
      for (const f of arr) mu += f[d] / arr.length;
      let v = 0;
      for (const f of arr) v += Math.pow(f[d] - mu, 2) / arr.length;
      perDimStd[d] += v;
    }
  }
  for (let d = 0; d < dims; d++) perDimStd[d] = Math.sqrt(perDimStd[d] / Math.max(1, n));
  console.error(`  voice-variation scale: ${Array.from(perDimStd, v => v.toFixed(2)).join(' ')}`);
}
const W = M.DEFAULT_W;
const zv = new Map();
for (const [tk, f] of feats) zv.set(tk, Float64Array.from(f, (v, d) => v / Math.max(0.02, perDimStd[d])));
const dist = (a, b) => {
  let s = 0;
  for (let d = 0; d < dims; d++) { const t = a[d] - b[d]; s += (W[M.FEATURES[d]] != null ? W[M.FEATURES[d]] : 1) * t * t; }
  return Math.sqrt(s);
};

/* ------------------------------------- 3. farthest-point sampling of the set */
const need = meanings.filter(g => !g.special).length + SPECIALS.length + 2;   // + counting meow + zero
console.error(`meanings needing a code: ${meanings.length} (+ count + zero = ${need})`);
const chosen = SPECIALS.slice();
while (chosen.length < need) {
  let bestTok = null, bestMin = -1;
  for (const tk of allTokens) {
    if (chosen.indexOf(tk) >= 0) continue;
    let mn = Infinity;
    for (const c of chosen) { const d = dist(zv.get(tk), zv.get(c)); if (d < mn) mn = d; }
    if (mn > bestMin) { bestMin = mn; bestTok = tk; }
  }
  chosen.push(bestTok);
}
/* How well are the chosen meows separated? Render each one twice with the
   voice-variation extremes and check that its nearest neighbour is still
   itself. That is exactly what the matcher has to do, so it is a fair preview. */
{
  let selfHit = 0, n = 0;
  for (const tk of chosen) {
    const probes = [
      fingerprint(tk, { voicePitch: 0.90, voiceSpeed: 0.94, noiseMul: 0.95, formantMul: 0.98 }),
      fingerprint(tk, { voicePitch: 1.12, voiceSpeed: 1.08, noiseMul: 1.10, formantMul: 1.02 }),
    ];
    for (const probe of probes) {
      const zq = Float64Array.from(probe.feat, (v, d) => v / Math.max(0.02, perDimStd[d]));
      let best = null, bestD = Infinity;
      for (const other of chosen) {
        const d = dist(zq, zv.get(other));
        if (d < bestD) { bestD = d; best = other; }
      }
      n++; if (best === tk) selfHit++;
    }
  }
  console.error(`  codebook self-consistency: ${(100 * selfHit / n).toFixed(1)}% of 2x voice variations still match themselves`);
}

let minPair = Infinity, minA = '', minB = '';
for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) {
  const d = dist(zv.get(chosen[i]), zv.get(chosen[j]));
  if (d < minPair) { minPair = d; minA = chosen[i]; minB = chosen[j]; }
}
console.error(`chose ${chosen.length} meows; closest pair ${minA} / ${minB} = ${minPair.toFixed(1)} voice-units`);

/* --------------------------------------------------- 4. bind to meanings */
const remaining = new Set(chosen.filter(t => SPECIALS.indexOf(t) < 0));
const assign = new Map();
let kept = 0, toneOnly = 0, free = 0;
for (const g of meanings) {
  if (g.special) { assign.set(g.canon, g.special); kept++; continue; }
  const cands = [...remaining];
  let pick = cands.find(t => { const q = T.parseToken(t); return q.tone === g.tone && q.length === g.len; });
  let how = 0;
  if (!pick) { pick = cands.find(t => T.parseToken(t).tone === g.tone); how = 1; }
  if (!pick) { pick = cands[0]; how = 2; }
  if (how === 0) kept++; else if (how === 1) toneOnly++; else free++;
  assign.set(g.canon, pick);
  remaining.delete(pick);
}
const COUNT = [...remaining][0]; remaining.delete(COUNT);
const ZERO = [...remaining][0]; remaining.delete(ZERO);
console.error(`assignment: ${kept} kept tone+length, ${toneOnly} tone only, ${free} free; count meow ${COUNT}, zero ${ZERO}`);

/* --------------------------------------------------- 5. build + emit LEX */
const LEX = {}, CANON = {}, PCANON = {}, GROUPS = [];
const asWords = (list, seq) => {
  const al = list.split('/').map(s => s.trim()).filter(Boolean);
  GROUPS.push({ canon: al[0], aliases: al, seq, kind: 'word' });
  al.forEach(w => { if (w.indexOf(' ') < 0) LEX[w] = seq; });
  CANON[seq] = al[0];
};
for (const g of meanings) asWords(g.aliases.join('/'), assign.get(g.canon));
asWords('zero', ZERO);

/* numbers: n repeats of the counting meow */
['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].forEach((w, idx) => {
  const seq = Array(idx + 1).fill(COUNT).join(' ');
  GROUPS.push({ canon: w, aliases: [w], seq, kind: 'number' });
  LEX[w] = seq; CANON[seq] = w;
});

/* phrases: readable readings for common sentences; their meows are just the
   words, so they cost nothing and the decoder gets a nicer answer */
const phraseLines = [];
for (const g of phrases) {
  // one reading per phrase, keyed by its canonical form, so PHR[canon] is exact
  for (const alias of [g.canon]) {
    const enc = E.encode(alias, LEX, {});
    if (!enc.tokens.length) continue;
    if (enc.notes.some(n => n.oov)) continue;              // phrase needs words we do not have
    const seq = enc.tokens.join(' ');
    if (CANON[seq] || PCANON[seq]) continue;               // already means something else
    PCANON[seq] = g.canon;
    GROUPS.push({ canon: g.canon, aliases: [alias], seq, kind: 'phrase' });
    phraseLines.push(`  phrase(${JSON.stringify(g.canon)}, '${seq}');`);
  }
}

const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const line = (g) => `  words(${JSON.stringify(g.aliases.join('/'))}, '${g.seq}');`;
const wordLines = meanings.map(g => line({ aliases: g.aliases, seq: assign.get(g.canon) }));

const out = `/* ============================================================================
   cat-translator :: lexicon.js        *** GENERATED by tools/make-lexicon.mjs ***

   English -> Meownese. Do not hand-edit; run \`node tools/make-lexicon.mjs\`, which
   re-designs the codebook against measured acoustics and rewrites this file.

   A token = onset-vowel-tone-length
      onset  : none | m | prr | h
      vowel  : a e i o u y
      tone   : flat | rise | fall | arch | dip     (semantics: fall = no/bad,
      length : short | normal | long                rise = question/urgency)

   Every line is one SYNONYM GROUP: the first word is what the decoder answers.
   Every meaning owns a distinct meow, picked so the ~120 sounds sit as far
   apart as possible in measured acoustic space (tools/make-lexicon.mjs), while
   keeping the tone and length of the original hand-written meow. Numbers are
   counted out as repeats of a single counting meow - cute, and an extra or
   missing meow only shifts the number instead of corrupting the sentence.
   ========================================================================== */
(function (g) {
  'use strict';

  const LEX = {};        // alias -> "tok tok"
  const PHR = {};        // phrase -> "tok tok"
  const CANON = {};      // "tok tok" -> canonical English
  const PCANON = {};
  const GROUPS = [];

  const words = (list, seq) => {
    const al = list.split('/').map(s => s.trim()).filter(Boolean);
    GROUPS.push({ canon: al[0], aliases: al, seq, kind: 'word' });
    al.forEach(w => { if (w.indexOf(' ') < 0) LEX[w] = seq; });
    CANON[seq] = al[0];
  };
  const phrase = (canon, seq) => {
    GROUPS.push({ canon, aliases: [canon], seq, kind: 'phrase' });
    PHR[canon] = seq;
    PCANON[seq] = canon;
  };

${wordLines.join('\n')}

  /* --------------------------------------------------------------- numbers */
  // n -> n repeats of the counting meow ("zero" gets a sound of its own).
  const COUNT = '${COUNT}';
  GROUPS.push({ canon: 'zero', aliases: ['zero'], seq: '${ZERO}', kind: 'number' });
  LEX.zero = '${ZERO}'; CANON['${ZERO}'] = 'zero';
  ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].forEach((w, idx) => {
    const seq = Array(idx + 1).fill(COUNT).join(' ');
    GROUPS.push({ canon: w, aliases: [w], seq, kind: 'number' });
    LEX[w] = seq; CANON[seq] = w;
  });

  /* ---------------------------------------------------- phrase readings */
${phraseLines.join('\n')}

  g.MEOW_LEXICON = LEX;
  g.MEOW_PHRASES = PHR;
  g.MEOW_CANON = { CANON, PCANON };
  g.MEOW_GROUPS = GROUPS;
  g.MEOW_COUNT_TOKEN = COUNT;
})(typeof globalThis !== 'undefined' ? globalThis : window);
`;
fs.writeFileSync(path.join(root, 'src/lexicon.js'), out);
console.error(`wrote src/lexicon.js: ${meanings.length + 12} meanings, ${phraseLines.length} phrase readings`);
