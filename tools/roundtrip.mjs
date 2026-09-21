/* Does the translator understand its own meows?
   Text -> the app's own encoder -> synthesized audio -> the app's own
   segmenter/classifier -> decoded text. Nothing simulated in between. */
import fs from 'node:fs'; import vm from 'node:vm';
for (const f of ['src/lexicon.js','src/tokens.js','src/engine.js','src/synth.js','src/match.js','src/templates.js'])
  vm.runInThisContext(fs.readFileSync(f,'utf8'), { filename: f });
const { MEOW_MATCH:M, MEOW_SYNTH:S, MEOW_ENGINE:E } = globalThis;
const T = M.fromJSON(globalThis.MEOW_TEMPLATES);

function recognizer(samples, sr) {
  const seg = M.segment(samples, sr);
  const tokens = [], conf = [];
  for (const u of (seg.meows || [])) {
    const an = M.analyze(u.samples, seg.sr);
    if (!an.ok) continue;
    const r = M.rankClasses(an.feat, T, 1);
    if (!r.ranked.length) continue;
    tokens.push(...r.ranked[0].tokens);
    conf.push(r.confidence);
  }
  return { decoded: E.decode(tokens), n: (seg.meows || []).length, conf };
}

const sets = {
  'core phrases': ['i love you','feed me','come here','good cat','i am hungry','where are you','no','hello','play','good night','i am sorry','purr','thank you','who is a good cat'],
  'single words': ['cat','food','friend','home','yes','sleep','happy','look','treat','milk'],
  'whole sentences': ['i love you cat','hello cat come here','where is my food','i am tired and hungry','please come here and pet me','you are a good friend','no no no'],
};
let grand = { n: 0, ok: 0, meows: 0, meowsOk: 0 };
for (const [name, phrases] of Object.entries(sets)) {
  console.log('\n' + name + ':');
  for (const p of phrases) {
    const enc = E.encode(p);
    if (!enc.tokens.length) { console.log(`  ${p.padEnd(34)} (not in the lexicon)`); continue; }
    const buf = S.renderUtterance(E.describeTokens(enc.tokens), { sr: 22050 });
    const r = recognizer(buf, 22050);
    /* token-level comparison is the honest one: synonyms decode to the group's
       chosen word, so compare meows, not spelling */
    const same = r.decoded.tokens.length === enc.tokens.length &&
                 r.decoded.tokens.every((t, i) => t === enc.tokens[i]);
    const conf = r.conf.length ? Math.round(100 * r.conf.reduce((a,b)=>a+b,0)/r.conf.length) : 0;
    console.log(`  ${p.padEnd(34)} ${same ? '✓' : '✗'}  "${r.decoded.text}"` +
      `   [${enc.tokens.length} meow${enc.tokens.length>1?'s':''}, heard ${r.n}, ${conf}%]`);
    grand.n++; grand.ok += same ? 1 : 0;
    grand.meows += enc.tokens.length; grand.meowsOk += same ? enc.tokens.length : 0;
  }
}
console.log(`\noverall: ${grand.ok}/${grand.n} phrases understood, ${grand.meowsOk}/${grand.meows} meows read back`);
