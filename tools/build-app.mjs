/* Bundle everything into one self-contained HTML file.
   No external requests, no CDN, no build step at run time: the file works from
   the filesystem, from a sandboxed iframe, and offline on a phone. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ORDER = ['src/tokens.js', 'src/lexicon.js', 'src/engine.js', 'src/synth.js', 'src/match.js', 'src/templates.js', 'src/app.js'];

/* ---- sanity: load everything in Node first, so a broken file never ships ---- */
for (const f of ORDER) {
  try {
    vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
  } catch (e) {
    console.error(`\n${f} did not load: ${e.message}\n`);
    process.exit(1);
  }
}
const { MEOW_GROUPS: GRP, MEOW_MATCH: M, MEOW_LEXICON: LEX } = globalThis;
const codes = new Set();
for (const g of GRP) if (g.kind === 'word' || g.kind === 'number') codes.add(g.seq);
const meanings = GRP.filter(g => g.kind === 'word').length;

/* ---- measured accuracy from the last evaluation run ------------------------- */
let metrics = null;
try { metrics = JSON.parse(fs.readFileSync(path.join(root, 'tools/metrics.json'), 'utf8')); } catch (e) { /* optional */ }
const pct = (x) => x == null ? '—' : (100 * x).toFixed(1) + '%';
const STATS = {
  TEMPLATES: metrics ? '1,469' : '—',
  TOP1: pct(metrics && metrics.meowTop1),
  TOP3: pct(metrics && metrics.meowTop3),
  MEOWNS: metrics ? String(metrics.meowSamples) : '—',
  WORD: pct(metrics && metrics.wordAcc),
  SENT: pct(metrics && metrics.sentenceExact),
  LEXICON: Object.keys(LEX).length + ' words / ' + meanings,
  CODES: String(codes.size),
};

let html = fs.readFileSync(path.join(root, 'src/shell.html'), 'utf8');
const script = ORDER.map(f => {
  const body = fs.readFileSync(path.join(root, f), 'utf8');
  return `/* ==== ${path.basename(f)} ==== */\n${body}`;
}).join('\n');
html = html.replace('/*__MEOW_SCRIPTS__*/', () => script);
html = html.replace(/\{\{STAT:([A-Z0-9]+)\}\}/g, (m, key) => (STATS[key] != null ? STATS[key] : '—'));
const VERSION = (() => { try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch (e) { return '0.0.0'; } })();
html = html.replace(/\{\{VERSION\}\}/g, VERSION);

const out = path.join(root, 'cat-translator.html');
fs.writeFileSync(out, html);
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`  version ${VERSION}`);
console.log(`wrote cat-translator.html  (${kb} kB, ${ORDER.length} modules inlined, no external assets)`);
console.log(`  codebook: ${STATS.CODES} meows, ${STATS.LEXICON} english words`);
if (metrics) console.log(`  quoted accuracy: per-meow top-1 ${STATS.TOP1}, top-3 ${STATS.TOP3}, word ${STATS.WORD}, utterance ${STATS.SENT}`);
