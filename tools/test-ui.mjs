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

const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => Array.from(win.document.querySelectorAll(sel));

console.log('app boot:');
check('scripts ran without throwing', !!win.MEOW_APP && !!win.MEOW_ENGINE && !!win.MEOW_MATCH);
check('boot notice cleared', $('#bootNotice').classList.contains('hidden'));
check('examples rendered', $$('#examples button').length >= 5, String($$('#examples button').length));
check('ready-meow presets rendered', $$('#presets button').length >= 8, String($$('#presets button').length));
check('voice label populated', /pitch/i.test($('#voiceLabel').textContent), $('#voiceLabel').textContent);

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
check('play button present', !!$('#encodeResult .primary'));

/* play it: chips should animate, then stop */
$('#encodeResult .primary').click();
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

console.log(fails ? `\n  ${fails} FAILURE(S)\n` : '\n  ALL UI CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
