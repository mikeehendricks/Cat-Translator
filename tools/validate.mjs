/* Validate the meow codec: lexicon hygiene + exact round-trips. */
import fs from 'node:fs';
import vm from 'node:vm';

const load = (f) => vm.runInThisContext(fs.readFileSync(new URL(f, import.meta.url).pathname.replace('/tools/../', '/'), 'utf8'), { filename: f });
load('../src/lexicon.js');
load('../src/tokens.js');
load('../src/engine.js');

const { MEOW_LEXICON: LEX, MEOW_PHRASES: PHR, MEOW_ENGINE: E, MEOW_TOKENS: T, MEOW_GROUPS: GRP } = globalThis;
let fails = 0;
const fail = (m) => { console.log('  ✗ ' + m); fails++; };

/* 1. duplicate word keys in the source (silently shadowed otherwise) ------------- */
const src = fs.readFileSync(new URL('../src/lexicon.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')      // strip block comments so docs don't look like code
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const seen = new Map();
const re = /words\('((?:[^'\\]|\\.)*)'(?:\s*,\s*'([^']*)')?/g;
let m;
while ((m = re.exec(src))) {
  if (!m[1].match(/^[a-z]/) || /[A-Z]/.test(m[1])) continue;  // skip helper calls
  m[1].split('/').forEach(w => {
    if (seen.has(w)) fail(`duplicate lexicon key "${w}" (defined twice)`);
    else seen.set(w, true);
  });
}
const re2 = /phrase\('((?:[^'\\]|\\.)*)'/g;
const seen2 = new Set();
while ((m = re2.exec(src))) {
  if (seen2.has(m[1])) fail(`duplicate phrase key "${m[1]}"`);
  seen2.add(m[1]);
}

/* 2. real collisions: two synonym GROUPS sharing one meow sequence ----------------- */
const bySeq = new Map();
for (const gr of GRP) {
  if (!bySeq.has(gr.seq)) bySeq.set(gr.seq, []);
  bySeq.get(gr.seq).push(gr.canon);
}
for (const [seq, cs] of bySeq) if (cs.length > 1) fail(`meow "${seq}" means ${cs.length} different things: ${cs.join(' | ')}`);
const wordSeqs = new Set(GRP.filter(g => g.kind === 'word').map(g => g.seq));
for (const gr of GRP.filter(g => g.kind === 'phrase')) if (wordSeqs.has(gr.seq)) fail(`phrase "${gr.canon}" has the same meow as a single word`);
for (const gr of GRP) if (gr.kind === 'word') for (const a of gr.aliases) if (/\s/.test(a)) fail(`alias "${a}" of "${gr.canon}" contains a space (dead entry)`);
for (const gr of GRP) if (new Set(gr.aliases).size !== gr.aliases.length) fail(`group "${gr.canon}" repeats an alias`);
for (const gr of GRP) if (LEX[gr.canon] !== gr.seq && PHR[gr.canon] !== gr.seq) fail(`canonical "${gr.canon}" is not reachable on the encode side`);

if ([...bySeq.values()].some(a => a.length > 1)) {
  console.log('  --- reverse-map collisions (a meow with two meanings) ---');
  for (const [seq, ens] of bySeq) if (ens.length > 1) console.log(`      ${seq.padEnd(52)} ${ens.join(' | ')}`);
}

/* 3. every token is renderable (has a synth descriptor) -------------------------- */
for (const [en, seq] of Object.entries(LEX)) {
  for (const tok of seq.split(' ')) {
    if (!T.describe(tok)) fail(`no synth descriptor for token "${tok}" (word "${en}")`);
    if (T.stringToTokens(tokensToString1(tok))[0] !== tok) fail(`token string round-trip broke for "${tok}"`);
  }
}
function tokensToString1(t) { return T.tokenToString(t); }

/* 4. exact round trip: encode(x) then decode() must preserve the token stream ----- */
const { rev } = E.buildReverse(LEX, PHR);
/** canonical English for a token sequence (what decode is allowed to answer) */
const canon = (seq) => rev.get(seq);
const corpus = [...Object.keys(LEX), ...Object.keys(PHR)];
let checked = 0, exactEn = 0;
for (const w of corpus) {
  const e = E.encode(w);
  const d = E.decode(e.tokens);
  // (a) every token survives, in order, with no re-segmentation surprises
  const consumed = [...d.segments.flatMap(s => s.tokens), ...d.unmatched];
  if (consumed.join(' ') !== e.tokens.join(' ')) fail(`token stream changed: "${w}" [${e.tokens}] -> [${consumed}]`);
  // (b) the English answer is the canonical form of exactly those words
  const gloss = e.notes.filter(n => !n.oov).map(n => canon(n.tokens.join(' ')))
    .filter((w, i, a) => w !== a[i - 1]).join(' ');   // decode folds adjacent repeats
  if (d.text !== gloss) fail(`round-trip: "${w}" -> [${e.tokens}] -> "${d.text}" (wanted "${gloss}")`);
  if (d.confidence < 0.999) fail(`round-trip confidence for "${w}" = ${d.confidence}`);
  if (d.text === w) exactEn++;
  checked++;
}

/* 5. random sentences, incl. punctuation / numbers / unknown words ---------------- */
const fun = ['the cat is hungry and wants more food', 'Hello! I love you so much, my little friend :)',
  'Please give me fish, I am very hungry', 'Do you want to play? Come here!', 'Never mind, thank you',
  'good morning my fluffy cat', 'I want 3 treats and 2 fish', 'this box is mine, sorry',
  'You are the best cat in the house, I love you', 'Where is my cat? he is sleeping on the bed',
  'can I pet you please', 'oh no, the door is closed', 'the vet... no', 'nonsense zzzq words here'];
const strict = [], reshaped = [];
for (const s of fun) {
  const e = E.encode(s);
  const d = E.decode(e.tokens);
  const gloss = e.notes.filter(n => !n.oov).map(n => canon(n.tokens.join(' ')))
    .filter((w, i, a) => w !== a[i - 1]).join(' ');
  // invariant: the decoder consumes exactly the tokens the encoder produced
  const consumed = [...d.segments.flatMap(x => x.tokens), ...d.unmatched].join(' ');
  if (consumed !== e.tokens.join(' ')) fail(`sentence token stream changed: "${s}"`);
  for (const seg of d.segments) if (!rev.get(seg.tokens.join(' '))) fail(`decoder invented the word "${seg.en}"`);
  if (d.text === gloss) strict.push(s); else reshaped.push({ s, got: d.text, want: gloss });
  checked++;
  console.log(`  ${d.text === gloss ? '·' : '~'} "${s}"\n      -> ${e.meow}`);
}

console.log(`\n  exact-word answers: ${exactEn}/${corpus.length}`);
console.log(`  sentences read back word-for-word: ${strict.length}/${strict.length + reshaped.length}`);
for (const r of reshaped) console.log(`    ~ "${r.s}"\n        encoder: ${r.want}\n        decoder: ${r.got}   <- legal re-segmentation (a phrase spanning the same meows)`);
console.log(`  lexicon: ${Object.keys(LEX).length} words + ${Object.keys(PHR).length} phrases | ${bySeq.size} unique meows`);
console.log(`  round-trips checked: ${checked}`);
console.log(fails ? `\n  ${fails} FAILURES\n` : '\n  ALL CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
