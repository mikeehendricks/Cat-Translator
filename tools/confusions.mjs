/* Where does the recogniser actually get confused? Renders every class under a
   spread of voices/rooms and tallies the resulting confusion pairs. */
import fs from 'node:fs'; import vm from 'node:vm';
for (const f of ['src/lexicon.js','src/tokens.js','src/engine.js','src/synth.js','src/match.js','src/templates.js'])
  vm.runInThisContext(fs.readFileSync(f,'utf8'), { filename: f });
const { MEOW_MATCH:M, MEOW_SYNTH:S, MEOW_ENGINE:E, MEOW_GROUPS:GRP } = globalThis;
const { captureAt } = await import('./capture.mjs');
const T = M.fromJSON(globalThis.MEOW_TEMPLATES);
const seqs = [], seen = new Set();
for (const g of GRP) { const t = g.seq.split(' '); if (t.length !== 1 || seen.has(t[0])) continue; seen.add(t[0]); seqs.push(t); }

const voices = [];
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 6; i++) voices.push({
  v: { pitch: 0.86 + 0.3 * rnd(), speed: 0.9 + 0.28 * rnd(), gruff: 0.85 + 0.35 * rnd() },
  gain: 0.5 + 0.9 * rnd(), noise: 0.002 + 0.02 * rnd(), lp: [0, 0, 2200, 3000, 4000][i % 5],
  sr: [22050, 22050, 48000, 16000, 22050, 48000][i],
});
const name = new Map(T.classes.map(c => [c.tokens.join(' '), c.tokens[0]]));
const pair = new Map(), perClass = new Map();
let total = 0, right = 0;
for (const seq of seqs) {
  let hit = 0, n = 0;
  for (const cfg of voices) {
    const dd = E.describeTokens(seq, cfg.v)[0];
    dd.noise = dd.noise * 1.1 + 0.003;
    const audio = S.renderUtterance([dd], { sr: 22050 });
    M.perturb(audio, 22050, cfg, 7);
    const an = M.analyze(captureAt(audio, cfg.sr), cfg.sr);
    if (!an.ok) continue;
    const r = M.rankClasses(an.feat, T, 1);
    if (!r.ranked.length) continue;
    const got = r.ranked[0].tokens.join(' ');
    n++; total++;
    if (got === seq.join(' ')) { hit++; right++; }
    else {
      const key = [seq.join(' '), got].sort().join('  <->  ');
      const rec = pair.get(key) || { a: name.get(seq.join(' ')), b: name.get(got), n: 0, ex: `${name.get(seq.join(' '))} heard as ${name.get(got)}` };
      rec.n++; pair.set(key, rec);
    }
  }
  perClass.set(seq.join(' '), { name: name.get(seq.join(' ')), acc: n ? hit / n : 0, n });
}
console.log(`overall top-1 over ${total} probes: ${(100 * right / total).toFixed(1)}%\n`);
console.log('worst classes:');
[...perClass.values()].sort((a, b) => a.acc - b.acc).slice(0, 12)
  .forEach(c => console.log(`  ${String(c.name).padEnd(12)} ${(100 * c.acc).toFixed(0)}%  (${c.n})`));
console.log('\ntop confusions:');
[...pair.values()].sort((a, b) => b.n - a.n).slice(0, 14)
  .forEach(p => console.log(`  ${String(p.a).padEnd(11)} <-> ${String(p.b).padEnd(11)} ${p.n}`));
