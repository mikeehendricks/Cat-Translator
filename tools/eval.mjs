/* ============================================================================
   End-to-end evaluation of the listening direction:
     synthetic meow recording (voice + mic conditions + capture rate)
       -> segment -> fingerprint -> nearest reference -> decode -> English
   Writes tools/metrics.json so the app and README can quote real numbers.
   ========================================================================== */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { captureAt } from './capture.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js', 'src/tokens.js', 'src/engine.js', 'src/synth.js', 'src/match.js', 'src/templates.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MEOW_MATCH: M, MEOW_SYNTH: S, MEOW_ENGINE: E, MEOW_GROUPS: GRP } = globalThis;
const templates = M.fromJSON(globalThis.MEOW_TEMPLATES);

const words = [];
const seenTok = new Set();
for (const gr of GRP) {
  const toks = gr.seq.split(' ');
  if (toks.length !== 1 || seenTok.has(toks[0])) continue;
  seenTok.add(toks[0]);
  words.push({ canon: gr.canon, tokens: toks });
}

let seed = Number(process.env.SEED || 424242);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

/** word-level accuracy on the best alignment of two word sequences */
function alignedMatches(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 1 : 0));
  }
  return dp[n][m];
}

const N = Number(process.env.N || 400);
const round = (x) => Math.round(x * 1000) / 1000;

const PROFILES = {
  selfTest:  { sr: [22050], pitch: [1, 1], speed: [1, 1], level: [1, 1], hiss: 0, muffle: 0, noMic: true },
  clean:     { sr: [22050, 48000], pitch: [0.9, 1.1], speed: [0.9, 1.1], level: [0.7, 1.2], hiss: 0.006, muffle: 0.05 },
  harsh:     { sr: [22050, 44100, 48000], pitch: [0.8, 1.3], speed: [0.85, 1.25], level: [0.4, 1.4], hiss: 0.02, muffle: 0.3 },
};
const lerp = (r) => r[0] + rnd() * (r[1] - r[0]);

function run(profile, n) {
  const acc = { top1: 0, top3: 0, meows: 0, aligned: 0, wordTot: 0, sentExact: 0, sentTot: 0, missed: 0 };
  const examples = [];
  for (let i = 0; i < n; i++) {
    const nw = 1 + Math.floor(rnd() * 4);
    const sentence = [];
    for (let k = 0; k < nw; k++) sentence.push(pick(words));

    const sr = pick(profile.sr);
    const pitch = lerp(profile.pitch), speed = lerp(profile.speed), gap = 0.06 + rnd() * 0.06;
    const descs = [];
    for (const w of sentence) for (const d of E.describeTokens(w.tokens)) {
      descs.push(Object.assign({}, d, {
        base: d.base * pitch, dur: d.dur * speed,
        noise: d.noise * (0.85 + rnd() * 0.4) + 0.003,
        formantScale: d.formantScale * (0.96 + rnd() * 0.08),
        rate: d.rate * (0.92 + rnd() * 0.16),
      }));
    }
    const audio = S.renderUtterance(descs, { sr: 22050, gap });

    const gain = lerp(profile.level);
    let ns = 999 + i, lp = 0;
    for (let j = 0; j < audio.length; j++) {
      audio[j] *= gain;
      ns = (ns * 1103515245 + 12345) & 0x7fffffff;
      const w = (ns / 0x3fffffff) - 1;
      lp += 0.02 * (w - lp);
      audio[j] += w * profile.hiss * (0.4 + rnd()) + lp * profile.hiss * 0.5;
    }
    if (rnd() < profile.muffle) {
      const a = Math.exp(-2 * Math.PI * (2400 + rnd() * 2400) / 22050);
      let y = 0;
      for (let j = 0; j < audio.length; j++) { y = audio[j] * (1 - a) + y * a; audio[j] = y; }
    }

    const seg = M.segment(captureAt(audio, sr), sr);
    const units = seg.meows || [];
    if (!units.length) { acc.missed++; acc.sentTot++; acc.wordTot += sentence.length; continue; }
    const ranked = units.map(u => {
      const an = M.analyze(u.samples, seg.sr);
      return an.ok ? M.rankClasses(an.feat, templates, 3) : null;
    }).filter(Boolean);

    if (ranked.length === sentence.length) {
      for (let k = 0; k < ranked.length; k++) {
        const want = sentence[k].tokens.join(' ');
        acc.meows++;
        const got = ranked[k].ranked[0] ? ranked[k].ranked[0].tokens.join(' ') : '';
        if (got === want) acc.top1++;
        if (ranked[k].ranked.slice(0, 3).some(x => x.tokens.join(' ') === want)) acc.top3++;
      }
    }
    const gotTokens = [];
    for (const r of ranked) if (r.ranked[0]) gotTokens.push.apply(gotTokens, r.ranked[0].tokens);
    const decoded = E.decode(gotTokens).text;
    const expect = sentence.map(w => w.canon).join(' ');
    acc.sentTot++;
    if (decoded === expect) acc.sentExact++;
    const expW = expect.split(' '), gotW = decoded ? decoded.split(' ') : [];
    acc.wordTot += expW.length;
    acc.aligned += alignedMatches(expW, gotW);
    if (decoded !== expect && examples.length < 6) examples.push(`wanted "${expect}"  heard "${decoded || '(nothing)'}"`);
  }
  return {
    metrics: {
      utterances: acc.sentTot,
      meowsPerUtterance: [1, 4],
      meowTop1: round(acc.top1 / Math.max(1, acc.meows)),
      meowTop3: round(acc.top3 / Math.max(1, acc.meows)),
      meowSamples: acc.meows,
      wordAcc: round(acc.aligned / Math.max(1, acc.wordTot)),
      sentenceExact: round(acc.sentExact / Math.max(1, acc.sentTot)),
      utterancesWithNoMeow: acc.missed,
    },
    examples,
  };
}

const out = {};
for (const [name, profile] of Object.entries(PROFILES)) {
  seed = Number(process.env.SEED || 424242);
  const r = run(profile, name === 'selfTest' ? Math.max(N, 200) : N);
  out[name] = r.metrics;
  console.log(`\n${name.toUpperCase()}  (${r.metrics.utterances} utterances, ${r.metrics.meowSamples} meows scored)`);
  console.log(`  per-meow  top-1 ${(100 * r.metrics.meowTop1).toFixed(1)}%   top-3 ${(100 * r.metrics.meowTop3).toFixed(1)}%`);
  console.log(`  word accuracy ${(100 * r.metrics.wordAcc).toFixed(1)}%    phrase read back exactly ${(100 * r.metrics.sentenceExact).toFixed(1)}%`);
  for (const e of r.examples) console.log(`    - ${e}`);
}
out.generatedAt = new Date().toISOString().slice(0, 10);
out.captureRates = [22050, 44100, 48000];

/* headline keys = the careful-microphone profile, with the rest alongside */
const headline = { ...out.clean, variants: { selfTest: out.selfTest, clean: out.clean, harsh: out.harsh } };
fs.writeFileSync(path.join(root, 'tools/metrics.json'), JSON.stringify(headline, null, 1));
console.log('\nwrote tools/metrics.json');
