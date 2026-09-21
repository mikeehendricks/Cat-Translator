/* ============================================================================
   Tune the matcher's per-dimension weights.
     - renders a fresh test set (never seen by the templates), analyses it once,
       and caches the fingerprints so the search itself costs milliseconds
     - coordinate ascent on held-out data, then reports held-out accuracy
   ========================================================================== */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js', 'src/tokens.js', 'src/engine.js', 'src/synth.js', 'src/match.js', 'src/templates.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MEOW_MATCH: M, MEOW_SYNTH: S, MEOW_ENGINE: E, MEOW_GROUPS: GRP } = globalThis;
const { captureAt } = await import('./capture.mjs');

const seqs = [], seen = new Set();
for (const gr of GRP) { if (!seen.has(gr.seq)) { seen.add(gr.seq); seqs.push({ tokens: gr.seq.split(' '), text: gr.canon }); } }

/* ---------------------------------------------------------------- test set */
/* One case = one meow, recorded under realistic conditions and then run through
   exactly the pipeline the app uses: resample (captureAt) -> segment -> one
   fingerprint. Ground truth is the token. */
function makeTest(seed, n) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let i = 0; i < n; i++) {
    const seq = pick(seqs);
    const sr = [22050, 44100, 48000][Math.floor(rnd() * 3)];
    const pitch = 0.78 + rnd() * 0.55, speed = 0.82 + rnd() * 0.5;
    const descs = E.describeTokens(seq.tokens).map(d => Object.assign({}, d, {
      base: d.base * pitch, dur: d.dur * speed,
      noise: d.noise * (0.75 + rnd() * 0.8) + 0.003,
      formantScale: d.formantScale * (0.94 + rnd() * 0.12),
      rate: d.rate * (0.9 + rnd() * 0.2),
    }));
    const gap = 0.06;
    const audio = S.renderUtterance(descs, { sr: 22050, gap });
    const gain = 0.4 + rnd();
    let ns = 12345 + i, lp = 0;
    for (let j = 0; j < audio.length; j++) {
      audio[j] *= gain;
      ns = (ns * 1103515245 + 12345) & 0x7fffffff;
      const w = (ns / 0x3fffffff) - 1;
      lp += 0.02 * (w - lp);
      audio[j] += w * (0.004 + rnd() * 0.02) + lp * 0.01;
    }
    if (rnd() < 0.35) {
      const a = Math.exp(-2 * Math.PI * (2200 + rnd() * 2500) / 22050);
      let y = 0;
      for (let j = 0; j < audio.length; j++) { y = audio[j] * (1 - a) + y * a; audio[j] = y; }
    }
    const seg = M.segment(captureAt(audio, sr), sr);
    const first = seg.meows[0];
    const an = first ? M.analyze(first.samples, seg.sr) : { ok: false };
    if (!an.ok) continue;
    cases.push({ feat: Array.from(an.feat), seq: seq.tokens.join(' ') });
  }
  return cases;
}

const cacheFile = path.join(root, 'tools/.cache/testset.json');
let cases;
if (process.env.REBUILD || !fs.existsSync(cacheFile)) {
  console.error('rendering + analysing test meows (one-off, ~1 min) ...');
  cases = makeTest(1234567, 1400);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cases));
} else {
  cases = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
}
const split = Math.floor(cases.length * 0.6);
const train = cases.slice(0, split), hold = cases.slice(split);
console.error(`cases: ${cases.length} (train ${train.length} / holdout ${hold.length})`);

/* ---------------------------------------------------------------- scoring */
const payload = globalThis.MEOW_TEMPLATES;
const templates = M.fromJSON(payload);
const F = M.FEATURES;
const CLASSES = templates.classes;

function evaluate(weights, set) {
  let hit1 = 0, hit3 = 0;
  const wobj = {};
  F.forEach((n, d) => { wobj[n] = weights[d]; });
  for (const c of set) {
    const scored = CLASSES.map(cls => ({
      key: cls.tokens.join(' '),
      s: M.gaussScore(c.feat, cls, wobj, templates.stats.mean, templates.stats.std),
    }));
    scored.sort((a, b) => a.s - b.s);
    if (scored[0] && scored[0].key === c.seq) hit1++;
    if (scored.slice(0, 3).some(r => r.key === c.seq)) hit3++;
  }
  return { exact: hit1 / set.length, tok: hit3 / set.length };
}

const baseW = Float64Array.from(F, (_, d) => {
  const name = F[d];
  return templates.stats.weights[name] != null ? templates.stats.weights[name] : 1;
});
const obj = (r) => r.exact + 0.3 * r.tok;

let best = baseW.slice();
let bestScore = obj(evaluate(best, train));
console.error(`start: train ${(100 * bestScore).toFixed(1)}  ${JSON.stringify(evaluate(best, hold))}`);

/* No dimension may be silenced: a feature the average meow does not need can
   still be the only thing that identifies a hiss or a chirp. */
const GRID = [0.5, 0.75, 1, 1.6, 2.6, 4];
for (let pass = 0; pass < 4; pass++) {
  let improved = false;
  for (let d = 0; d < F.length; d++) {
    const orig = best[d];
    let localBest = orig, localScore = bestScore;
    for (const g of GRID) {
      const trial = best.slice(); trial[d] = g;
      const sc = obj(evaluate(trial, train));
      if (sc > localScore + 1e-6) { localScore = sc; localBest = g; }
    }
    if (localBest !== orig) { best[d] = localBest; bestScore = localScore; improved = true; }
  }
  console.error(`pass ${pass + 1}: train ${(100 * bestScore).toFixed(1)}  holdout exact/tok ${(() => { const r = evaluate(best, hold); return (100 * r.exact).toFixed(1) + '% / ' + (100 * r.tok).toFixed(1) + '%'; })()}`);
  if (!improved) break;
}

const rTrain = evaluate(best, train), rHold = evaluate(best, hold), rBaseHold = evaluate(baseW, hold), rBaseTrain = evaluate(baseW, train);
console.log(`\nbaseline  train top1 ${(100 * rBaseTrain.exact).toFixed(1)}%  top3 ${(100 * rBaseTrain.tok).toFixed(1)}%   |  holdout top1 ${(100 * rBaseHold.exact).toFixed(1)}%  top3 ${(100 * rBaseHold.tok).toFixed(1)}%`);
console.log(`tuned     train top1 ${(100 * rTrain.exact).toFixed(1)}%  top3 ${(100 * rTrain.tok).toFixed(1)}%   |  holdout top1 ${(100 * rHold.exact).toFixed(1)}%  top3 ${(100 * rHold.tok).toFixed(1)}%`);
const table = {};
F.forEach((n, d) => { table[n] = Math.round(best[d] * 100) / 100; });
console.log('\nweights:', JSON.stringify(table));

/* persist: tuned weights belong with the templates they were tuned against */
fs.writeFileSync(path.join(root, 'tools/tuned-weights.json'), JSON.stringify(table, null, 1));
const out = JSON.parse(JSON.stringify(payload));
out.weights = table;
fs.writeFileSync(path.join(root, 'src/templates.js'),
  '/* generated by tools/build-templates.mjs - reference meow fingerprints. do not edit. */\n' +
  'globalThis.MEOW_TEMPLATES = ' + JSON.stringify(out) + ';\n');
console.log('updated src/templates.js weights + tools/tuned-weights.json');
