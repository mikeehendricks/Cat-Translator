/* Render meows to .wav files (same audio path the browser uses). */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
for (const f of ['src/lexicon.js', 'src/tokens.js', 'src/engine.js', 'src/synth.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const { MEOW_SYNTH: S, MEOW_ENGINE: E, MEOW_TOKENS: T } = globalThis;

const args = process.argv.slice(2);
const outDir = path.join(root, 'audio');
fs.mkdirSync(outDir, { recursive: true });

/* audio/<name>.wav :  node tools/render.mjs "hello my cat" "purr" ... */
const items = args.length ? args : [
  'hello', 'i love you', 'feed me', 'come here', 'no', 'purr', 'hiss', 'chatter',
];
const SR = 44100;

/* also emit one file per raw token for the recogniser sanity-check */
if (args[0] === '--tokens') {
  const seen = new Set();
  for (const seq of Object.values(globalThis.MEOW_CANON.CANON)) { /* noop */ }
  for (const g of globalThis.MEOW_GROUPS) for (const tk of g.seq.split(' ')) seen.add(tk);
  let k = 0;
  for (const tk of seen) {
    const d = T.describe(tk);
    const s = S.renderUtterance([d], { sr: SR });
    fs.writeFileSync(path.join(outDir, 'tok_' + tk + '.wav'), Buffer.from(S.encodeWav(s, SR)));
    k++;
  }
  console.log(`wrote ${k} token wavs to ${path.relative(root, outDir)}/`);
} else {
  for (const item of items) {
    const enc = E.encode(item);
    const descs = E.describeTokens(enc.tokens);
    if (!descs.length) { console.log(`skip "${item}"`); continue; }
    const s = S.renderUtterance(descs, { sr: SR });
    const name = item.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.wav';
    fs.writeFileSync(path.join(outDir, name), Buffer.from(S.encodeWav(s, SR)));
    console.log(`"${item}"\n   meow  ${enc.meow}\n   ->    audio/${name}  (${(s.length / SR).toFixed(2)}s, ${enc.tokens.length} meows)\n   back  ${E.decode(enc.tokens).text}`);
  }
}
