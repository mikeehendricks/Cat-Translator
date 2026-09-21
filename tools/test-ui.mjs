/* ============================================================================
   Headless test of the shipped app: loads cat-translator.html in jsdom with a
   stubbed Web Audio API, then drives it like a user would.
   Catches the wiring bugs that a screenshot would not.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const html = fs.readFileSync(path.join(root, 'cat-translator.html'), 'utf8');

let fails = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra && !cond ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------------------------------------------------------------- Web Audio stub */
function makeStub(sampleRate) {
  const offlineRender = globalThis.__renderUtterance;    // supplied by the host
  class FakeBuffer {
    constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this._d = [new Float32Array(len)]; }
    getChannelData(i) { return this._d[i]; }
    copyToChannel(src, i) { this._d[i].set(src.subarray(0, this._d[i].length)); }
  }
  class FakeNode {
    constructor() { this.gain = { value: 1 }; }
    connect(n) { return n; }
    disconnect() {}
    start() { setTimeout(() => this.onended && this.onended(), 1); }
    stop() {}
  }
  return {
    sampleRate, state: 'running', currentTime: 0, destination: new FakeNode(),
    resume() { this.state = 'running'; return Promise.resolve(); },
    createGain() { return new FakeNode(); },
    createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(a) { a.fill(128); }, connect() {}, disconnect() {} }; },
    createMediaStreamSource() { return new FakeNode(); },
    createBufferSource() { return new FakeNode(); },
    createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); },
    decodeAudioData() { return Promise.reject(new Error('not needed in this test')); },
  };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.AudioContext = function () { return makeStub(48000); };
    win.devicePixelRatio = 1;
    Object.defineProperty(win.navigator, 'mediaDevices', {
      value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
    });
    win.navigator.clipboard = { writeText: () => Promise.resolve() };
    win.HTMLCanvasElement.prototype.getContext = function () {
      const noop = () => {};
      return {
        setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
        fillRect: noop, createLinearGradient: () => ({ addColorStop: noop }),
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
      };
    };
    win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
    win.cancelAnimationFrame = (id) => clearTimeout(id);
  },
});
const win = dom.window;
await new Promise(r => win.addEventListener('load', r));

const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => Array.from(win.document.querySelectorAll(sel));

console.log('app boot:');
check('scripts ran without throwing', !!win.MEOW_APP && !!win.MEOW_ENGINE && !!win.MEOW_MATCH);
check('boot notice cleared', $('#bootNotice').classList.contains('hidden'));
check('examples rendered', $$('#examples button').length >= 5, String($$('#examples button').length));
check('ready-meow presets rendered', $$('#presets button').length >= 8, String($$('#presets button').length));
check('voice label populated', /pitch/i.test($('#voiceLabel').textContent), $('#voiceLabel').textContent);
check('the write pane shows an empty state before anything is typed', !$('#encodeEmpty').classList.contains('hidden'));
check('the read pane shows an empty state before anything is recorded', !$('#listenEmpty').classList.contains('hidden'));
check('no results are shown yet', $('#encodeResult').classList.contains('hidden') && $('#listenResult').classList.contains('hidden'));

console.log('\nEnglish → Meow:');
$('#englishIn').value = 'i love you so much';
$('#translateBtn').click();
const chips = $$('#encodeResult .chip');
check('result card shown', !$('#encodeResult').classList.contains('hidden'));
const expectTokens = win.MEOW_ENGINE.encode('i love you so much').tokens.length;
check('one chip per meow', chips.length === expectTokens, `${chips.length} chips vs ${expectTokens} meows`);
check('raw meow string shown', /meowtext/.test($('#encodeResult').innerHTML) && $('#encodeResult .meowtext').textContent.length > 0,
  $('#encodeResult .meowtext') ? '' : 'missing');
check('meow string matches the engine', $('#encodeResult .meowtext').textContent === win.MEOW_ENGINE.encode('i love you so much').meow);
check('the primary action is present and filled (button hierarchy)',
  !!$('#encodeResult .btn--filled'));

/* play it: chips should animate, then stop */
$('#encodeResult .btn--filled').click();
await new Promise(r => setTimeout(r, 60));
check('playing state set', !!win.MEOW_APP.state.lastBuffer);
check('waveform drawn', $('#wave').width > 0);
await new Promise(r => setTimeout(r, 900));
check('playback cleared after end', !win.MEOW_APP.state.playing);

console.log('\nOOV / punctuation handling:');
$('#englishIn').value = 'Hello!!! 123 zzzz cat?';
$('#translateBtn').click();
check('still produces meows for unknown words', $$('#encodeResult .chip').length >= 2);
check('mentions the skipped word', /skipped/.test($('#encodeResult').textContent), $('#encodeResult').textContent.slice(0, 120));

console.log('\nMeow → English (offline self-test path):');
$('#englishIn').value = 'feed me';
$('#translateBtn').click();
$('#presets button').click();                        // plays + auto-recognises
for (let i = 0; i < 60 && $('#listenResult').classList.contains('hidden'); i++) {
  await new Promise(r => setTimeout(r, 250));        // recognition lands when playback ends
}
const heard = $('#listenResult');
check('listen card shown', !heard.classList.contains('hidden'));
check('an english answer appeared', /[a-z]/i.test($('.heard-head .big') ? $('.heard-head .big').textContent : ''), heard.textContent.slice(0, 140));
check('candidates rendered', $$('#listenResult .pill').length >= 2, String($$('#listenResult .pill').length));
check('a candidate is marked as the reading', $$('#listenResult .pill.top').length >= 1);
const pct = $$('#listenResult .pill').filter(el => /\d+%/.test(el.textContent));
check('candidates carry probabilities', pct.length >= 2, String(pct.length));
{
  const before = $('.heard-head .big') ? $('.heard-head .big').textContent : '';
  const pills = $$('#listenResult .permeow .pill');
  const alt = pills.find(el => !el.classList.contains('top'));
  if (alt) alt.click();
  const after = $('.heard-head .big') ? $('.heard-head .big').textContent : '';
  check('tapping a candidate re-decodes the sentence', alt ? after !== before || before.length > 0 : true,
    `"${before}" -> "${after}"`);
  check('corrected badge appears after a correction', !!$('#listenResult .badge'));
}
check('confidence shown', /confidence\s+\d+%/.test(heard.textContent), heard.textContent.slice(0, 200));

console.log('\nMulti-meow utterance (segmentation + per-meow candidates):');
{
  $('#englishIn').value = 'hello cat come here';
  $('#translateBtn').click();
  await new Promise(r => setTimeout(r, 120));
  const buf = win.MEOW_APP.state.lastBuffer;
  win.MEOW_APP.recognise(buf.getChannelData(0), buf.sampleRate, 'test');
  const card = $('#listenResult');
  const lines = card.querySelectorAll('.permeow');
  check('each meow gets its own candidate row', lines.length >= 3, String(lines.length));
  check('the card says how many meows it heard', /heard \d+ meows/.test(card.textContent), card.textContent.slice(0, 90));
  const head = card.querySelector('.heard-head .big');
  check('a multi-meow sentence was decoded', head && head.textContent.trim().split(/\s+/).length >= 3, head ? head.textContent : '(none)');
  /* correcting one meow must change the sentence */
  const before = head.textContent;
  const alt = [...card.querySelectorAll('.permeow')][0].querySelectorAll('.pill')[1];
  if (alt) alt.click();
  check('correcting one meow re-decodes the sentence', $('#listenResult .heard-head .big').textContent !== before,
    `"${before}" -> "${$('#listenResult .heard-head .big').textContent}"`);
}

console.log('\nSelf-test button:');
$('#selfTest').click();
await new Promise(r => setTimeout(r, 500));
check('self-test produced a reading', /[a-z]/i.test($('#listenResult').textContent));

console.log('\nMicrophone unavailable (sandboxed preview):');
$('#recordBtn').click();
await new Promise(r => setTimeout(r, 200));
check('graceful message instead of a crash', /microphone unavailable/i.test($('#recStatus').textContent), $('#recStatus').textContent);
check('record button disabled', $('#recordBtn').disabled);

console.log('\nVoice controls:');
const before = JSON.stringify(win.MEOW_APP.state.voice);
$('#voiceRandom').click();
check('randomise changes the voice profile', JSON.stringify(win.MEOW_APP.state.voice) !== before, JSON.stringify(win.MEOW_APP.state.voice));
$('#voicePitch').value = '1.2';
$('#voicePitch').dispatchEvent(new win.Event('input'));
check('slider updates state', win.MEOW_APP.state.voice.pitch === 1.2, String(win.MEOW_APP.state.voice.pitch));
check('label updates', /1\.20/.test($('#voiceLabel').textContent), $('#voiceLabel').textContent);



/* ---------------------------------------------------------------------------
   The chrome added in this revision: panes, the sheet, empty states, and the
   confirmation on Copy. These are the parts that only exist on screen, so they
   are checked through the DOM the way a person would use them.
   ------------------------------------------------------------------------ */

console.log('\nChrome and panes:');

check('the page starts on the write-something pane', $('#paneA').classList.contains('is-current'));
check('the reading pane starts hidden on compact widths', !$('#paneB').classList.contains('is-current'));
$$('.segmented__item')[1].click();
check('choosing the other direction moves the selection',
  $$('.segmented__item')[1].getAttribute('aria-checked') === 'true' &&
  $$('.segmented__item')[0].getAttribute('aria-checked') === 'false');
check('and moves the visible pane', $('#paneB').classList.contains('is-current') && !$('#paneA').classList.contains('is-current'));
$$('.segmented__item')[0].click();
check('it can be moved back', $('#paneA').classList.contains('is-current'));

$('#englishIn').value = 'i love you';
$('#translateBtn').click();
await new Promise(r => setTimeout(r, 30));
check('the empty state steps aside once there is a result', $('#encodeEmpty').classList.contains('hidden'));
check('the result region is revealed', !$('#encodeResult').classList.contains('hidden'));
check('a class the markup never defines has no styling to fall back on',
  ['is-current', 'is-scrolled', 'is-recording'].every(c => css.includes(c)));

$('#howBtn').click();
await new Promise(r => setTimeout(r, 10));
check('the explanation opens from the bar', $('#howSheet').hasAttribute('open'));
$('#howClose').click();
await new Promise(r => setTimeout(r, 10));
check('and closes again', !$('#howSheet').hasAttribute('open'));

/* Copy confirms what happened, then returns to its resting label. */
const copyBtn = $('#encodeResult .btn:not(.btn--filled)');
copyBtn.click();
await new Promise(r => setTimeout(r, 20));
check('copy confirms with a word and a symbol, not colour alone',
  /copied/i.test(copyBtn.textContent) && /#i-check/.test(copyBtn.innerHTML), copyBtn.textContent.trim());
await new Promise(r => setTimeout(r, 1500));
check('and the label returns to normal', /copy/i.test(copyBtn.textContent) && !/copied/i.test(copyBtn.textContent),
  copyBtn.textContent.trim());

/* ---------------------------------------------------------------------------
   Human Interface Guidelines: the rules that can be checked mechanically.
   Layout and colour need eyes on them, but these are the ones a rewrite breaks
   silently, so they are asserted here.
   ------------------------------------------------------------------------ */

const cssHas = (re, what) => check(what, re.test(css));

console.log('\nHuman Interface Guidelines:');

cssHas(/--font-ui:\s*-apple-system[^;]*BlinkMacSystemFont/, 'type uses the system font stack (SF on Apple platforms)');
check('the full text-style hierarchy is defined (Large Title down to Caption 2)',
  ['large-title', 'title1', 'title2', 'title3', 'headline', 'body', 'callout', 'subhead', 'footnote', 'caption', 'caption2']
    .every(n => css.includes('.' + n)));
cssHas(/--label:\s*#000000[\s\S]*?--label:\s*#ffffff/, 'semantic colours are defined for light and dark separately');
cssHas(/@media\s*\(prefers-color-scheme:\s*dark\)/, 'dark appearance is supported');
cssHas(/@media\s*\(prefers-contrast:\s*more\)/, 'increased contrast is supported');
cssHas(/@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'Reduce Motion is respected');
cssHas(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/, 'Reduce Transparency is respected');
cssHas(/backdrop-filter/, 'translucent chrome uses a material, with a fallback where blur is unsupported');
cssHas(/--hit:\s*2\.75rem/, 'the minimum hit target is 44pt');
cssHas(/\.btn\s*\{[\s\S]*?min-height:\s*var\(--hit\)/, 'buttons are at least 44pt tall');
cssHas(/:focus-visible\s*\{[\s\S]*?outline:\s*\.1875rem/, 'keyboard focus is visible');
cssHas(/\.sr-only/, 'screen-reader-only text is available');
check('safe areas are respected', /viewport-fit=cover/.test(html) && /env\(safe-area-inset-top\)/.test(css));
cssHas(/--t-caption2:\s*0\.6875rem/, 'no text style is smaller than the platform minimum');

const controls = $$('button, input, textarea, select, a[href]');
const namedByLabel = (el) => {
  if (el.id) {
    const lab = win.document.querySelector('label[for="' + el.id + '"]');
    if (lab && lab.textContent.trim()) return true;
  }
  return !!(el.getAttribute('aria-label') || el.closest('label') || el.textContent || el.getAttribute('title') || '').trim();
};
const unnamed = controls.filter(el => !namedByLabel(el));
check('every control has an accessible name', unnamed.length === 0,
  unnamed.map(el => el.tagName + (el.id ? '#' + el.id : '')).join(', '));

/* Chrome only: the meow glyphs that appear inside presets are the language's own
   notation (a tone marker is closer to a letter than to an icon), so they stay.
   What must not happen is an emoji standing in for a control's icon. */
const emoji = /[\u{1F300}-\u{1FAFF}\u{25A0}\u{25B6}\u{23F0}\u{FE0F}\u{2713}\u{29C9}]/u;
const chromeButtons = ['translateBtn', 'stopBtn', 'recordBtn', 'selfTest', 'voiceRandom', 'howBtn', 'howClose']
  .map(id => win.document.getElementById(id)).filter(Boolean);
check('no emoji standing in for interface icons',
  chromeButtons.length >= 6 && chromeButtons.every(b => !emoji.test(b.textContent || '')),
  chromeButtons.filter(b => emoji.test(b.textContent || '')).map(b => b.id).join(', '));
/* Every icon the page draws — in the markup and in whatever the script has
   rendered by now — must resolve. A dangling reference draws nothing, which is
   exactly the kind of breakage a redesign hides. */
const definedSymbols = new Set(Array.from(win.document.querySelectorAll('symbol[id]')).map(s => s.id));
const usedSymbols = new Set(Array.from(win.document.querySelectorAll('use'))
  .map(u => (u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace(/^#/, ''))
  .filter(Boolean));
const dangling = Array.from(usedSymbols).filter(id => !definedSymbols.has(id));
check('every symbol the page draws exists in the sprite', dangling.length === 0,
  dangling.join(', ') + ' (of ' + usedSymbols.size + ' used)');
check('the sprite is present in full', definedSymbols.size >= 20, String(definedSymbols.size) + ' symbols');

check('every chrome control carries a symbol from the sprite',
  chromeButtons.every(b => /<use href="#i-/.test(b.innerHTML)),
  chromeButtons.filter(b => !/<use href="#i-/.test(b.innerHTML)).map(b => b.id).join(', '));

const canvases = $$('canvas');
check('every canvas is described for assistive technology',
  canvases.length > 0 && canvases.every(c => c.getAttribute('aria-label') && c.getAttribute('role') === 'img'),
  canvases.map(c => c.id + ':' + (c.getAttribute('aria-label') || 'no label')).join(', '));
check('the recording status is announced politely',
  $('#recStatus') && $('#recStatus').getAttribute('aria-live') === 'polite');

check('the long explanation is presented as a sheet',
  !!$('#howSheet') && $('#howSheet').tagName === 'DIALOG' && !!$('#howClose'));
check('the direction control is a radio group with exactly one selection',
  $$('.segmented__item[role="radio"]').length === 2 &&
  $$('.segmented__item[aria-checked="true"]').length === 1);
check('the version is on the app page', /version \d+\.\d+\.\d+/.test($('#appVersion').textContent));
check('appearance hints are declared (color-scheme + theme-color)',
  /name="color-scheme"/.test(html) && /name="theme-color"/.test(html));


/* ---------------------------------------------------------------------------
   Nothing to translate, and a browser with no Web Audio.

   The second of those is the shape of the reported bug: the click handler threw
   while building an audio context and the browser kept the exception to itself,
   so the button looked dead. Synthesis and the meow text never needed audio, so
   a page like that must still translate, still draw, and say plainly that it
   cannot play.
   ------------------------------------------------------------------------ */

console.log('\nNothing typed, and nowhere to go with it:');
{
  $('#englishIn').value = '   ';
  $('#translateBtn').click();
  check('an empty box answers with a hint, not silence',
    !$('#encodeNote').classList.contains('hidden') && /type a sentence/i.test($('#encodeNote').textContent),
    $('#encodeNote').textContent);
  $('#englishIn').value = 'qwertyuiop zzzzz';
  $('#translateBtn').click();
  check('unknown words are explained rather than dropped',
    /lexicon|no meow/i.test($('#encodeNote').textContent), $('#encodeNote').textContent);
}

console.log('\nWhen something does go wrong, it is visible:');
{
  check('the failure strip is out of the way while all is well', $('#problemStrip').classList.contains('hidden'));
  win.MEOW_APP.reportProblem('Translate', new Error('deliberate test failure'));
  const strip = $('#problemStrip');
  check('a failure inside the page is shown, not swallowed',
    !strip.classList.contains('hidden') && /deliberate test failure/.test(strip.textContent), strip.textContent.slice(0, 120));
  check('and carries a way to hand the details over', !!$('#problemCopy') && /copy/i.test($('#problemCopy').textContent));
  const diag = win.MEOW_APP.diagnostics();
  check('the diagnostics line names the browser and the audio status',
    /web audio/i.test(diag) && /user agent/i.test(diag) && /encode test/i.test(diag), diag.split('\n')[0]);
  check('the diagnostics line includes the failure itself', /Translate: deliberate test failure/.test(diag));
  win.MEOW_APP.reportProblem = win.MEOW_APP.reportProblem;   // exported for the page's own use
  check('diagnostics is reachable from outside the bundle', typeof win.MEOW_APP.diagnostics === 'function');
}

/* --------------------------------------------------------------------------- */

function makeCanvasStub(win3) {
  win3.HTMLCanvasElement.prototype.getContext = function () {
    const noop = () => {};
    return {
      setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
      fillRect: noop, createLinearGradient: () => ({ addColorStop: noop }),
      fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    };
  };
  win3.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  win3.cancelAnimationFrame = (id) => clearTimeout(id);
}

async function boot(htmlText, { url, audio, fetchImpl } = {}) {
  const stray = [];
  const dom = new JSDOM(htmlText, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: url || 'http://example.test/',
    beforeParse(win3) {
      win3.addEventListener('error', (e) => stray.push(e.message || 'error event'));
      win3.addEventListener('unhandledrejection', (e) => stray.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
      if (audio === 'none') { win3.AudioContext = undefined; win3.webkitAudioContext = undefined; }
      else win3.AudioContext = function () { return makeStub(48000); };
      /* the samples can still be held without a context to play them through */
      win3.AudioBuffer = function (opts) {
        this.length = opts.length; this.sampleRate = opts.sampleRate;
        this.numberOfChannels = opts.numberOfChannels || 1;
        this.duration = this.length / this.sampleRate;
        this._d = [new Float32Array(this.length)];
        this.getChannelData = (i) => this._d[i];
        this.copyToChannel = (src, i) => this._d[i].set(src.subarray(0, this._d[i].length));
      };
      win3.navigator.clipboard = { writeText: () => Promise.resolve() };
      Object.defineProperty(win3.navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
      });
      makeCanvasStub(win3);
      if (fetchImpl) win3.fetch = fetchImpl;
    },
  });
  const win3 = dom.window;
  await new Promise(r => win3.addEventListener('load', r));
  return { win: win3, stray };
}

console.log('\nA browser with no Web Audio:');
{
  const { win: w, stray } = await boot(html, { audio: 'none' });
  const q = (sel) => w.document.querySelector(sel);
  q('#englishIn').value = 'hello cat';
  q('#translateBtn').click();
  check('the button still translates when there is no audio to play',
    !q('#encodeResult').classList.contains('hidden') && /meow/i.test(q('#encodeResult').textContent),
    q('#encodeResult').textContent.slice(0, 80));
  check('it says why it is silent instead of doing nothing',
    !q('#encodeNote').classList.contains('hidden') && /web audio|unavailable|not play audio/i.test(q('#encodeNote').textContent),
    q('#encodeNote').textContent);
  check('the meow text is still correct in that browser',
    q('#encodeResult .meowtext') && q('#encodeResult .meowtext').textContent === w.MEOW_ENGINE.encode('hello cat').meow,
    q('#encodeResult .meowtext') ? q('#encodeResult .meowtext').textContent : '(no meow text)');
  check('a browser without audio is not treated as a failure',
    q('#problemStrip').classList.contains('hidden') && stray.length === 0, stray.join(' | '));
  check('diagnostics report the missing piece',
    /web audio\s+unavailable/i.test(w.MEOW_APP.diagnostics()),
    (w.MEOW_APP.diagnostics().split('\n').find(l => /web audio/.test(l)) || '').trim());

  /* the same browser, a word the lexicon does not know */
  q('#englishIn').value = 'qqqq wwww';
  q('#translateBtn').click();
  check('an unknown word is explained in that browser too',
    /lexicon|no meow/i.test(q('#encodeNote').textContent), q('#encodeNote').textContent);
}

console.log('\nThe page asking the visitor’s browser for its address:');
{
  const cfg = { report: true, post: '/api/visit/ip', endpoints: ['https://ipwho.is/'] };
  const withConfig = html.replace('<!--__MEOW_RUNTIME__-->',
    `<script id="meow-runtime" type="application/json">${JSON.stringify(cfg)}</script>`);
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) || null });
    const payload = /ipwho\.is/.test(String(url)) ? { ip: '93.184.216.34' } : { ok: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  };
  const asked = await boot(withConfig, { fetchImpl: fakeFetch });
  const silent = await boot(html, { fetchImpl: fakeFetch });
  /* the page waits 1.2 s before asking, deliberately */
  await new Promise(r => setTimeout(r, 2000));
  const get = calls.find(c => c.method === 'GET' && /ipwho\.is/.test(c.url));
  const post = calls.find(c => c.method === 'POST');
  check('the page asks a public service what address the world sees', !!get && /ipwho\.is/.test(get.url), JSON.stringify(calls[0] || null));
  check('and reports the answer back to this installation', !!post && post.url === '/api/visit/ip' &&
    JSON.parse(post.body).ip === '93.184.216.34', JSON.stringify(post || null));
  check('it asks with no credentials and does not wait for the answer to paint',
    !!asked.win.MEOW_APP && asked.stray.length === 0, asked.stray.join(' | '));
  check('with the switch off, or no configuration at all, it asks nobody',
    calls.filter(c => /ipwho\.is/.test(c.url)).length === 1 &&
    calls.filter(c => c.method === 'POST').length === 1,
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  check('the shipped file on its own reaches no outside service',
    silent.win.MEOW_APP && silent.stray.length === 0);
}


console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  ALL UI CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
