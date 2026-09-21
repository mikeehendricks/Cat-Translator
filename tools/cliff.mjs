/* Where does recognition actually break? Same meows, conditions added one at a time. */
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js','src/tokens.js','src/engine.js','src/synth.js','src/match.js','src/templates.js'])
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const { MEOW_MATCH:M, MEOW_SYNTH:S, MEOW_ENGINE:E, MEOW_GROUPS:GRP } = globalThis;
const { captureAt } = await import('./capture.mjs');
const templates = M.fromJSON(globalThis.MEOW_TEMPLATES);
const seqs=[]; const seen=new Set();
for (const g of GRP) if (!seen.has(g.seq)) { seen.add(g.seq); seqs.push(g.seq); }

const conditions = [
  ['nominal (identical to a template)', { p:1, s:1, g:1, n:0, lp:0, sr:22050, gap:0.06 }],
  ['pitch/speed only',                  { p:1.09, s:1.12, g:1, n:0, lp:0, sr:22050, gap:0.07 }],
  ['+ level change',                    { p:1.09, s:1.12, g:0.5, n:0, lp:0, sr:22050, gap:0.07 }],
  ['+ light hiss',                      { p:1.09, s:1.12, g:0.5, n:0.008, lp:0, sr:22050, gap:0.07 }],
  ['+ muffled mic (2.6 kHz)',           { p:1.09, s:1.12, g:0.5, n:0.008, lp:2600, sr:22050, gap:0.07 }],
  ['48 kHz sample rate',                { p:1.09, s:1.12, g:0.5, n:0.008, lp:2600, sr:48000, gap:0.07 }],
  ['16 kHz sample rate',                { p:1.09, s:1.12, g:0.5, n:0.008, lp:2600, sr:16000, gap:0.07 }],
];
for (const [label, cfg] of conditions) {
  let hit = 0, n = 0;
  for (const seq of seqs) {
    /* render exactly like the app does, then segment and read each meow back —
       a phrase is only counted if every meow in it came back correctly */
    const descs = E.describeTokens(seq.split(' '), { pitch: cfg.p, speed: cfg.s, gruff: 1 });
    if (!descs.length) continue;
    const audio = S.renderUtterance(descs, { sr: 22050, gap: cfg.gap });
    M.perturb(audio, 22050, { gain: cfg.g, noise: cfg.n, lp: cfg.lp }, 3);
    const seg = M.segment(captureAt(audio, cfg.sr), cfg.sr);
    const units = seg.meows || [];
    if (!units.length) continue;
    const tokens = [];
    let bestDist = 0, runnerUp = 0;
    for (const u of units) {
      const an = M.analyze(u.samples, seg.sr);
      if (!an.ok) continue;
      const r = M.rankClasses(an.feat, templates, 3);
      if (!r.ranked.length) continue;
      tokens.push(...r.ranked[0].tokens);
      bestDist = Math.max(bestDist, r.ranked[0].score || 0);
    }
    n++;
    if (tokens.join(' ') === seq) hit++;   // whole phrase read back
  }
  console.log(`${label.padEnd(36)} top1 ${(100*hit/n).toFixed(1).padStart(5)}%   (n=${n})`);
}
