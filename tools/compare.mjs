/* Template matching vs the per-class Gaussian model, same fingerprints. */
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js','src/tokens.js','src/engine.js','src/synth.js','src/match.js','src/templates.js'])
  vm.runInThisContext(fs.readFileSync(path.join(root,f),'utf8'), { filename: f });
const { MEOW_MATCH:M, MEOW_SYNTH:S, MEOW_ENGINE:E, MEOW_GROUPS:GRP } = globalThis;
const { captureAt } = await import('./capture.mjs');
const T = M.fromJSON(globalThis.MEOW_TEMPLATES);
const seqs=[], seen=new Set();
for (const g of GRP) { const t=g.seq.split(' '); if (t.length!==1||seen.has(t[0])) continue; seen.add(t[0]); seqs.push(t); }

const conditions = [
  ['nominal voice',        { v: { pitch: 1,    speed: 1,    gruff: 1 },    gain: 1,    noise: 0,     lp: 0,    sr: 22050 }],
  ['deeper voice (0.9x)',  { v: { pitch: 0.90, speed: 1,    gruff: 1 },    gain: 1,    noise: 0,     lp: 0,    sr: 22050 }],
  ['higher voice (1.12x)', { v: { pitch: 1.12, speed: 1,    gruff: 1 },    gain: 1,    noise: 0,     lp: 0,    sr: 22050 }],
  ['faster voice',         { v: { pitch: 1,    speed: 1.15, gruff: 1 },    gain: 1,    noise: 0,     lp: 0,    sr: 22050 }],
  ['gruff voice',          { v: { pitch: 1,    speed: 1,    gruff: 1.3 },  gain: 1,    noise: 0,     lp: 0,    sr: 22050 }],
  ['quiet room, 48 kHz',   { v: { pitch: 1.05, speed: 1.08, gruff: 1.1 },  gain: 0.7,  noise: 0.006, lp: 2600, sr: 48000 }],
  ['harsh (noisy+muffled)',{ v: { pitch: 0.88, speed: 0.92, gruff: 0.9 },  gain: 0.5,  noise: 0.02,  lp: 2200, sr: 48000 }],
  ['phone band, 16 kHz',   { v: { pitch: 1.02, speed: 1.05, gruff: 1 },    gain: 0.8,  noise: 0.008, lp: 3400, sr: 16000 }],
];
const rows = [];
for (const [label, cfg] of conditions) {
  let t1=0, t3=0, g1=0, g3=0, n=0;
  for (const seq of seqs) {
    const dd = E.describeTokens(seq, cfg.v)[0];        // exactly the app's voice path
    dd.noise = dd.noise * 1.05 + 0.002;
    const audio = S.renderUtterance([dd], { sr: 22050 });
    M.perturb(audio, 22050, { gain: cfg.g, noise: cfg.n, lp: cfg.lp }, 7);
    const an = M.analyze(captureAt(audio, cfg.sr), cfg.sr);
    if (!an.ok) continue;
    n++;
    const want = seq.join(' ');
    const rT = M.rankUnique(an.feat, T, 3);
    const rG = M.rankClasses(an.feat, T, 3);
    if (rT.ranked[0] && rT.ranked[0].tokens.join(' ')===want) t1++;
    if (rT.ranked.slice(0,3).some(x=>x.tokens.join(' ')===want)) t3++;
    if (rG.ranked[0] && rG.ranked[0].tokens.join(' ')===want) g1++;
    if (rG.ranked.slice(0,3).some(x=>x.tokens.join(' ')===want)) g3++;
  }
  rows.push([label, t1/n, t3/n, g1/n, g3/n, n]);
}
console.log('condition'.padEnd(24), 'templates t1/t3'.padEnd(18), 'gaussian t1/t3');
for (const [l,t1,t3,g1,g3,n] of rows)
  console.log(l.padEnd(24), `${(100*t1).toFixed(0)}% / ${(100*t3).toFixed(0)}%`.padEnd(18), `${(100*g1).toFixed(0)}% / ${(100*g3).toFixed(0)}%`, `  (n=${n})`);
