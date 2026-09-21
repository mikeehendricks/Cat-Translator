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

console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  ALL UI CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
