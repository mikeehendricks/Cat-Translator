/* Which meows are genuinely hard to tell apart? */
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js', 'src/tokens.js', 'src/engine.js', 'src/synth.js', 'src/match.js', 'src/templates.js'])
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const { MEOW_MATCH: M, MEOW_ENGINE: E } = globalThis;
const T = M.fromJSON(globalThis.MEOW_TEMPLATES);
const F = M.FEATURES, S = T.stats;

/* class means + within-class std (in z units) */
const byClass = new Map();
for (const it of T.items) { const k = it.tokens.join(' '); if (!byClass.has(k)) byClass.set(k, []); byClass.get(k).push(it.feat); }
const cls = [];
for (const [k, arr] of byClass) {
  const mean = new Float64Array(F.length);
  for (const f of arr) for (let d = 0; d < F.length; d++) mean[d] += f[d] / arr.length;
  const sd = new Float64Array(F.length);
  for (const f of arr) for (let d = 0; d < F.length; d++) sd[d] += Math.pow((f[d] - mean[d]) / S.std[d], 2) / arr.length;
  for (let d = 0; d < F.length; d++) sd[d] = Math.sqrt(sd[d]);
  cls.push({ k, tokens: k.split(' '), mean, sd: Float64Array.from(sd, Math.sqrt), n: arr.length });
}
const zmean = (c) => Float64Array.from(c.mean, (v, d) => (v - S.mean[d]) / S.std[d]);
const dist = (a, b, mask) => {
  let s = 0, m = 0;
  for (let d = 0; d < a.length; d++) if (!mask || mask(d)) { const t = a[d] - b[d]; s += t * t; m++; }
  return Math.sqrt(s / (m || 1));
};
const vowelOnly = (d) => !['b', 'c', 'e', 'r', 'a', 'l', 'h', 'f', 'v', 'm', 'd', 'o'].includes(F[d][0]) || /^b/.test(F[d]);
const pairs = [];
for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) {
  const a = cls[i], b = cls[j];
  if (a.tokens.length !== 1 || b.tokens.length !== 1) continue;
  const onlyVowel = a.tokens[0].split('-').filter((x, k) => k !== 1).join('-') === b.tokens[0].split('-').filter((x, k) => k !== 1).join('-');
  const za = zmean(a), zb = zmean(b);
  pairs.push({ a: a.k, b: b.k, d: dist(za, zb), onlyVowel, sd: [...a.sd, ...b.sd].reduce((x, y) => x + y, 0) / (2 * a.sd.length) });
}
pairs.sort((x, y) => x.d - y.d);
console.log(`classes: ${cls.length};  mean within-class spread (z units): ${(cls.reduce((s, c) => s + c.sd.reduce((x, y) => x + y, 0) / F.length, 0) / cls.length).toFixed(2)}`);
console.log('\nmost confusable meow pairs (distance in within-class units):');
for (const p of pairs.slice(0, 14)) console.log(`  ${p.d.toFixed(2).padStart(5)}  ${p.a.padEnd(20)} vs ${p.b.padEnd(20)} ${p.onlyVowel ? '(vowel only)' : ''}`);
console.log('\neasiest pairs:');
for (const p of pairs.slice(-4)) console.log(`  ${p.d.toFixed(2).padStart(5)}  ${p.a.padEnd(20)} vs ${p.b.padEnd(20)}`);
/* how much does each dimension contribute to separating the closest 40 pairs? */
const near = pairs.slice(0, 40);
const contrib = new Float64Array(F.length);
for (const p of near) {
  const a = cls.find(c => c.k === p.a), b = cls.find(c => c.k === p.b);
  const za = zmean(a), zb = zmean(b);
  for (let d = 0; d < F.length; d++) contrib[d] += Math.pow(za[d] - zb[d], 2);
}
const order = [...contrib.keys()].sort((i, j) => contrib[j] - contrib[i]);
console.log('\nmost useful dims for the confusable pairs:', order.slice(0, 12).map(i => `${F[i]}=${contrib[i].toFixed(0)}`).join(' '));
console.log('least useful           :', order.slice(-10).map(i => F[i]).join(' '));
