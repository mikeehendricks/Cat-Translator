/* ============================================================================
   cat-translator :: app.js
   The interface. Two directions:
     English -> Meow   encode + synthesise + play (with a live "saying it" trace)
     Meow -> English   record (or replay a preset) -> segment -> match -> decode
   Mic access is unavailable in some sandboxes, so the listening pane always
   offers self-tests that run entirely offline on audio we generated ourselves.
   ========================================================================== */
(function (g) {
  'use strict';
  // resolve the DOM lazily so this file can also be loaded in Node for testing
  const doc = { get el() { return g.document; } };
  const $ = (sel, root) => (root || g.document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || g.document).querySelectorAll(sel));
  /* Inline symbol from the sprite in the page. Icons carry meaning next to their
     label, never instead of it, and never as the only signal of a state. */
  const SYM = (id, cls) => `<svg class="symbol${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;

  const state = {
    voice: { pitch: 1, speed: 1, gruff: 1 },
    playing: null,            // current AudioBufferSourceNode
    lastBuffer: null,         // last thing we played (used by the self-test)
    lastMeow: null,           // {meow, glyphs, text}
    mediaRecorder: null,
    recording: null,
    templates: null,
    presets: [],
    analyser: null,
    rafId: 0,
    problems: [],
  };

  /* ---------------------------------------------------------------- problems */
  /**
   * Say something when the app cannot do what was asked.
   *
   * An exception thrown inside a click handler is invisible: the button simply
   * does nothing, which is indistinguishable from a broken page. Every failure
   * that can happen while the app is running ends up here, in the strip above
   * the panes, with the words that describe it and a copyable diagnostic line —
   * so "it does nothing" can be reported as something specific.
   */
  function reportProblem(what, err) {
    const text = (err && (err.message || String(err))) || 'unknown error';
    state.problems.push({ what, text, at: Date.now() });
    const strip = $('#problemStrip');
    if (!strip) return;
    strip.classList.remove('hidden');
    strip.classList.toggle('notice--warn', true);
    strip.innerHTML = `${SYM('i-warning')}<span><b>${what}</b> — ${text}</span>` +
      `<button type="button" class="btn btn--plain btn--small" id="problemCopy">Copy details</button>`;
    const copy = $('#problemCopy');
    if (copy) copy.onclick = () => {
      const line = diagnostics();
      if (navigator.clipboard) navigator.clipboard.writeText(line).then(() => { copy.textContent = 'Copied'; });
    };
  }

  function diagnostics() {
    const lines = [
      'Cat Translator diagnostics',
      'time        ' + new Date().toISOString(),
      'url         ' + (g.location ? g.location.href : '(none)'),
      'user agent  ' + (navigator.userAgent || 'unknown'),
      'web audio   ' + (audioUnavailable() ? 'unavailable: ' + audioUnavailable() : 'available'),
      'mediaDevices ' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'yes' : 'no'),
      'dialog      ' + (typeof g.HTMLDialogElement !== 'undefined' && g.HTMLDialogElement.prototype.showModal ? 'yes' : 'no'),
      'text styles ' + (g.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red, blue)') ? 'color-mix yes' : 'color-mix no'),
      'encode test ' + (function () {
        try { const e = MEOW_ENGINE.encode('i love you so much'); return e.tokens.length + ' meows, "' + e.meow + '"'; }
        catch (err) { return 'FAILED: ' + (err.message || err); }
      })(),
      'problems    ' + (state.problems.length ? state.problems.map(p => p.what + ': ' + p.text).join(' | ') : 'none'),
    ];
    return lines.join('\n');
  }

  /** Run a handler so that a throw becomes a visible message, never silence. */
  function guard(what, fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (err) { reportProblem(what, err); return undefined; }
    };
  }

  /* ------------------------------------------------------------------ audio */
  /**
   * The audio context, or null when this browser cannot give us one.
   *
   * It is created on first use, inside a click, and every failure short of a
   * working context is answered with null rather than an exception: a browser
   * without Web Audio, a privacy mode that refuses to start one, a webview whose
   * audio service is missing. Synthesis and the waveform do not need a context
   * at all, so a browser like that can still translate and draw — it just cannot
   * play, and it says so instead of doing nothing.
   */
  let ctx = null;
  let audioError = null;
  function audio() {
    if (ctx) {
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* still usable */ } }
      return ctx;
    }
    const AC = g.AudioContext || g.webkitAudioContext;
    if (typeof AC !== 'function') { audioError = new Error('this browser has no Web Audio'); return null; }
    try {
      ctx = new AC();
      state.master = ctx.createGain();
      state.master.gain.value = 0.9;
      state.master.connect(ctx.destination);
    } catch (err) {
      audioError = err;
      ctx = null;
      return null;
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* the click that got us here counts as a gesture */ } }
    return ctx;
  }
  const audioUnavailable = () => audioError ? (audioError.message || String(audioError)) : null;

  /**
   * Synthesise tokens at the canonical rate and hand back something buffer-like.
   *
   * The samples are ours either way. A context is only needed to *hold* them for
   * playback, and if there is no context we still try the standalone AudioBuffer
   * so the waveform, the clock and the read-back keep working — the one thing
   * lost is the sound itself. Returning null is a normal outcome, not an error:
   * every caller already checks.
   */
  function bufferForTokens(tokens, voice) {
    const sr = g.MEOW_MATCH.SR0;
    const descs = MEOW_ENGINE.describeTokens(tokens, voice);
    if (!descs.length) return null;
    const samples = MEOW_SYNTH.renderUtterance(descs, {
      sr, gap: 0.075, voicePitch: 1, voiceSpeed: 1,
    });
    const c = audio();
    if (c) {
      try {
        const buf = c.createBuffer(1, samples.length, sr);
        buf.copyToChannel(samples, 0);
        return buf;
      } catch (err) { audioError = err; }
    }
    if (typeof g.AudioBuffer === 'function') {
      try {
        const buf = new g.AudioBuffer({ length: samples.length, sampleRate: sr, numberOfChannels: 1 });
        buf.copyToChannel(samples, 0);
        return buf;
      } catch (err) { /* not offered without a context either */ }
    }
    return null;
  }

  function playBuffer(buf, onProgress) {
    stopPlayback();
    const c = audio();
    if (!c) return false;
    const src = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.value = 1;
    src.connect(gain).connect(state.master);
    state.playing = { src, startedAt: c.currentTime };
    state.lastBuffer = buf;
    drawWave(buf);
    src.start();
    if (onProgress) {
      const t0 = c.currentTime, dur = buf.duration;
      const tick = () => {
        const p = Math.min(1, (c.currentTime - t0) / dur);
        onProgress(p);
        if (p < 1 && state.playing && state.playing.src === src) state.rafId = requestAnimationFrame(tick);
        else onProgress(1);
      };
      state.rafId = requestAnimationFrame(tick);
    }
    src.onended = () => { if (state.playing && state.playing.src === src) state.playing = null; };
    return src;
  }
  function stopPlayback() {
    if (state.playing) { try { state.playing.src.stop(); } catch (e) { /* already stopped */ } state.playing = null; }
    if (state.rafId) cancelAnimationFrame(state.rafId);
  }

  /* -------------------------------------------------------- little graphics */
  function drawWave(buf) {
    const cv = $('#wave');
    if (!cv || !buf) return;
    const dpr = g.devicePixelRatio || 1;
    const w = cv.clientWidth || 600, h = cv.clientHeight || 90;
    cv.width = w * dpr; cv.height = h * dpr;
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    x.strokeStyle = 'rgba(255,214,102,0.95)';
    x.lineWidth = 1.4;
    x.beginPath();
    for (let i = 0; i < w; i++) {
      let mn = 1, mx = -1;
      const off = i * step;
      for (let k = 0; k < step; k += 1) {
        const v = data[off + k] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const y1 = h / 2 - mx * h * 0.42, y2 = h / 2 - mn * h * 0.42;
      x.moveTo(i + 0.5, y1); x.lineTo(i + 0.5, y2);
    }
    x.stroke();
  }

  function drawLevel(t) {                       // recording level meter
    const cv = $('#meter');
    if (!cv) return;
    const dpr = g.devicePixelRatio || 1;
    const w = cv.clientWidth || 260, h = cv.clientHeight || 14;
    cv.width = w * dpr; cv.height = h * dpr;
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.10)';
    x.fillRect(0, 0, w, h);
    const grad = x.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#7bf1a8'); grad.addColorStop(0.7, '#ffd666'); grad.addColorStop(1, '#ff6b6b');
    x.fillStyle = grad;
    x.fillRect(0, 0, w * Math.min(1, t * 1.6), h);
  }

  /* ----------------------------------------------------------- pane: encode */
  function renderMeowCard(enc) {
    const card = $('#encodeResult');
    const empty = $('#encodeEmpty');
    /* Nothing to say (an empty box, or every word out of vocabulary) leaves the
       empty state in place: a card saying "0 meows" is noise, not feedback. */
    const wanted = enc.tokens.length > 0 || enc.notes.some(n => n.oov);
    card.classList.toggle('hidden', !wanted);
    if (empty) empty.classList.toggle('hidden', wanted);
    card.innerHTML = '';
    if (!wanted) return [];
    const glyphRow = doc.el.createElement('div');
    glyphRow.className = 'glyphs';
    const chips = enc.tokens.map((tk, i) => {
      const s = doc.el.createElement('span');
      s.className = 'chip';
      s.dataset.i = String(i);
      s.innerHTML = `<b>${MEOW_TOKENS.tokenToGlyph(tk)}</b><i>${MEOW_TOKENS.tokenToString(tk)}</i>`;
      s.title = tk;
      glyphRow.appendChild(s);
      return s;
    });
    card.appendChild(glyphRow);

    const txt = doc.el.createElement('div');
    txt.className = 'meowtext';
    txt.textContent = enc.meow || '(nothing to say)';
    card.appendChild(txt);

    const info = doc.el.createElement('div');
    info.className = 'muted small';
    const oov = enc.notes.filter(n => n.oov).map(n => n.text);
    info.innerHTML = `${enc.tokens.length} meow${enc.tokens.length === 1 ? '' : 's'}` +
      (oov.length ? ` · no meow for: <em>${oov.join(', ')}</em> (skipped)` : '') +
      (enc.tokens.length ? ` · about ${(MEOW_SYNTH.plan ? estDuration(enc.tokens) : 0).toFixed(1)}s of cat` : '');
    card.appendChild(info);

    const row = doc.el.createElement('div');
    row.className = 'row';
    const play = doc.el.createElement('button');
    play.className = 'btn btn--filled';
    play.innerHTML = `${SYM('i-play')}<span>Say it to the cat</span>`;
    play.onclick = () => sayIt(enc.tokens, chips);
    const copy = doc.el.createElement('button');
    copy.className = 'btn';
    copy.innerHTML = `${SYM('i-copy')}<span>Copy meow text</span>`;
    copy.onclick = () => {
      const t = enc.meow;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => {
        copy.innerHTML = `${SYM('i-check')}<span>Copied</span>`;
        setTimeout(() => { copy.innerHTML = `${SYM('i-copy')}<span>Copy meow text</span>`; }, 1400);
      });
    };
    row.appendChild(play); row.appendChild(copy);
    card.appendChild(row);
    return chips;
  }

  function estDuration(tokens) {
    return MEOW_ENGINE.describeTokens(tokens).reduce((s, d) => s + d.dur + 0.075, 0);
  }

  function sayIt(tokens, chips) {
    const buf = bufferForTokens(tokens, state.voice);
    if (!buf) return;
    playBuffer(buf, (p) => {
      const n = chips ? chips.length : 0;
      if (!n) return;
      const idx = Math.min(n - 1, Math.floor(p * n));
      chips.forEach((c, i) => c.classList.toggle('active', i === idx));
      if (p >= 1) chips.forEach(c => c.classList.remove('active'));
    });
    state.lastMeowTokens = tokens;
  }

  /* ------------------------------------------------------------ pane: listen */
  /**
   * Render one recognition result. Every meow keeps its top candidates, so the
   * user can tap the reading they meant and the sentence rebuilds immediately —
   * the honest version of "the cat understood you".
   */
  function renderRecognition(rec) {
    const card = $('#listenResult');
    const empty = $('#listenEmpty');
    /* Something was recorded and read back: an attempt happened, so the reading
       replaces the empty state even when the answer is "nothing heard" — that
       is feedback, and it is the feedback the person needs most. */
    if (empty) empty.classList.add('hidden');
    card.classList.remove('hidden');
    card.innerHTML = '';

    if (!rec || !rec.per.length) {
      const head = doc.el.createElement('div');
      head.className = 'heard-head';
      head.innerHTML = `<span class="badge warn">nothing heard</span> <span class="muted">${(rec && rec.reason) || 'try again, a little closer to the mic'}</span>`;
      card.appendChild(head);
      return;
    }

    const tokens = [];
    for (let i = 0; i < rec.per.length; i++) {
      const r = rec.per[i];
      const pick = r.ranked[Math.min(rec.chosen[i], r.ranked.length - 1)];
      tokens.push.apply(tokens, pick ? pick.tokens : []);
    }
    const decoded = MEOW_ENGINE.decode(tokens);

    const head = doc.el.createElement('div');
    head.className = 'heard-head';
    const conf = rec.per.reduce((s, r, i) => s + (r.confidence || 0), 0) / rec.per.length;
    head.innerHTML = `<span class="badge ok">${rec.per.length === 1 ? 'heard' : 'heard ' + rec.per.length + ' meows'}</span>` +
      `<b class="big">${decoded.text || '(nothing)'}</b>` +
      (rec.chosen.some(c => c > 0) ? ' <span class="badge info">' + SYM('i-check') + 'corrected</span>' : '');
    card.appendChild(head);

    const meta = doc.el.createElement('div');
    meta.className = 'muted small';
    const m0 = rec.per[0].meta || {};
    meta.innerHTML = `${(rec.durSec || 0).toFixed(2)}s of cat · ` +
      `${m0.f0medHz ? Math.round(m0.f0medHz) + ' Hz' : 'no clear pitch'}` +
      (m0.rumble > 0.5 ? ' · purring' : '') +
      (m0.modul > 0.35 ? ' · trilling' : '') +
      ` · ${MEOW_TOKENS.tokensToString(tokens)} · confidence ${Math.round(conf * 100)}%` +
      (rec.ms ? ` · read in ${rec.ms} ms` : '');
    card.appendChild(meta);

    /* one block per meow: the chosen word, then the alternatives */
    rec.per.forEach((r, i) => {
      const line = doc.el.createElement('div');
      line.className = 'permeow';
      const label = doc.el.createElement('span');
      label.className = 'muted small';
      label.textContent = rec.per.length > 1 ? `meow ${i + 1}: ` : '';
      line.appendChild(label);
      r.ranked.slice(0, 4).forEach((c, k) => {
        const b = doc.el.createElement('button');
        b.className = 'pill' + (rec.chosen[i] === k ? ' top' : '');
        b.textContent = MEOW_ENGINE.decode(c.tokens).text + (c.prob ? ` ${Math.round(c.prob * 100)}%` : '');
        b.title = 'play this meow';
        b.onclick = (ev) => {
          if (ev.shiftKey) { playTokens(c.tokens); return; }
          rec.chosen[i] = k;
          renderRecognition(rec);
        };
        line.appendChild(b);
      });
      card.appendChild(line);
    });

    const hint = doc.el.createElement('div');
    hint.className = 'hintbar';
    hint.innerHTML = rec.pitchHint ? `${SYM('i-info')} ${rec.pitchHint}` :
      (rec.per.length > 1 ? 'Tap a reading to correct it — the sentence updates at once. Shift-click hears it.' : '');
    card.appendChild(hint);
  }

  function playTokens(tokens) {
    const buf = bufferForTokens(tokens, state.voice);
    if (buf) playBuffer(buf);
  }

  /** Segment a recording, classify every meow in it, then decode the stream. */
  function recognise(samples, sr, label) {
    const t0 = performance.now();
    const seg = MEOW_MATCH.segment(samples, sr);
    const units = seg.meows || [];
    if (!units.length) { renderRecognition({ per: [], reason: 'too quiet to call a meow', chosen: [] }); return; }

    const per = [];
    for (const unit of units) {
      const an = MEOW_MATCH.analyze(unit.samples, seg.sr);
      if (!an.ok) continue;
      const r = MEOW_MATCH.rankClasses(an.feat, state.templates, 4);
      if (!r.ranked.length) continue;
      per.push({ ranking: r, meta: an.meta, ranked: r.ranked, confidence: r.confidence });
    }
    if (!per.length) { renderRecognition({ per: [], reason: 'nothing I could call a meow', chosen: [] }); return; }

    const rec = {
      per: per.map(p => ({ ranked: p.ranked, confidence: p.confidence, meta: p.meta })),
      chosen: per.map(() => 0),
      durSec: units.reduce((s, u) => s + u.durSec, 0),
      ms: Math.round(performance.now() - t0),
      label,
    };
    const f0 = per[0].meta.f0medHz;
    if (f0 && (f0 < 330 || f0 > 950)) {
      rec.pitchHint = `your meow sat around ${Math.round(f0)} Hz — the codec's reference voice is ~560 Hz, ` +
        `so try a ${f0 < 330 ? 'higher' : 'lower'}-pitched "meeee-ooow"`;
    }
    if (per[0].meta.harmonicity < 0.25 && per[0].meta.rumble < 0.3) {
      rec.pitchHint = 'that was mostly hiss to me — get closer to the mic, or meow a bit louder';
    }
    state.lastRec = rec;
    renderRecognition(rec);
  }

  /* ------------------------------------------------------------------- mic */
  async function startRecording() {
    const btn = $('#recordBtn'), status = $('#recStatus');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const c = audio();
      const src = c.createMediaStreamSource(stream);
      const an = c.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      state.analyser = an;
      const chunks = [];
      const rec = new MediaRecorder(stream);
      state.mediaRecorder = rec;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        cancelAnimationFrame(state.recRaf);
        drawLevel(0);
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
        status.textContent = 'Reading the meow…';
        try {
          const arr = await blob.arrayBuffer();
          const decoded = await audio().decodeAudioData(arr.slice(0));
          const data = decoded.getChannelData(0);
          recognise(data, decoded.sampleRate, 'mic');
          status.textContent = '';
        } catch (err) {
          status.textContent = 'could not decode that recording (' + (err && err.name ? err.name : 'error') + ')';
        }
        btn.innerHTML = `${SYM('i-mic')}<span>Record a meow</span>`;
        btn.classList.remove('is-recording');
        btn.setAttribute('aria-pressed', 'false');
        checkSelfTest();
      };
      rec.start();
      state.recording = true;
      btn.innerHTML = `${SYM('i-stop')}<span>Stop recording</span>`;
      btn.classList.add('is-recording');
      btn.setAttribute('aria-pressed', 'true');
      status.textContent = 'listening… meow now';
      const buf = new Uint8Array(an.fftSize);
      const meter = () => {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
        drawLevel(Math.sqrt(s / buf.length) * 3);
        state.recRaf = requestAnimationFrame(meter);
      };
      meter();
    } catch (err) {
      status.innerHTML = 'microphone unavailable here — no problem: use the <b>ready meows</b> below, they run entirely offline.';
      btn.disabled = true;
      btn.classList.remove('rec');
    }
  }

  function stopRecording() {
    if (state.mediaRecorder && state.recording) {
      state.recording = false;
      try { state.mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
  }

  /* --------------------------------------------------------------- presets */
  /* Every preset must be fully covered by the lexicon, otherwise a chip would
     advertise a sentence the codec can only half say. */
  const PRESETS = ['i love you', 'i want food', 'come here', 'good cat', 'i am hungry', 'you are good',
    'no', 'hello', 'play', 'good night', 'i am sorry', 'purr', 'pet me please', 'thank you'];
  function buildPresets() {
    const wrap = $('#presets');
    wrap.innerHTML = '';
    PRESETS.forEach((phrase) => {
      const enc = MEOW_ENGINE.encode(phrase);
      if (!enc.tokens.length) return;
      const b = doc.el.createElement('button');
      b.className = 'preset';
      b.innerHTML = `<b>${phrase}</b><i>${enc.glyphs}</i>`;
      b.onclick = () => {
        const buf = bufferForTokens(enc.tokens, state.voice);
        if (!buf) return;
        state.lastBufferTokens = enc.tokens;
        playBuffer(buf);
        setTimeout(() => {
          /* decode the buffer we just played: an honest end-to-end self-test */
          const samples = buf.getChannelData(0);
          recognise(samples, buf.sampleRate, 'preset:' + phrase);
          const res = $('#listenResult');
          if (res.scrollIntoView) res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, Math.round(buf.duration * 1000) + 260);
      };
      wrap.appendChild(b);
    });
  }

  function checkSelfTest() {
    $('#selfTest').classList.toggle('hidden', !state.lastBuffer);
  }

  function selfTest() {
    if (!state.lastBuffer) return;
    recognise(state.lastBuffer.getChannelData(0), state.lastBuffer.sampleRate, 'self');
  }

  /* ---------------------------------------------------------------- startup */
  function init() {
    state.templates = MEOW_MATCH.fromJSON(g.MEOW_TEMPLATES);
    const t0 = performance.now();
    state.templatesReadyMs = Math.round(performance.now() - t0);

    const examples = ['i love you so much', 'feed me please', 'do you want to play', 'good morning little cat', 'where are you', 'thank you my friend', 'i want 3 treats'];
    const box = $('#examples');
    examples.forEach(ex => {
      const b = doc.el.createElement('button');
      b.className = 'tag';
      b.textContent = ex;
      b.onclick = () => { $('#englishIn').value = ex; guard('Translation failed', doEncode)(); };
      box.appendChild(b);
    });

    buildPresets();
    $('#translateBtn').onclick = guard('Translation failed', doEncode);
    $('#englishIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) guard('Translation failed', doEncode)(); });
    $('#recordBtn').onclick = guard('Recording failed', () => (state.recording ? stopRecording() : startRecording()));
    $('#selfTest').onclick = guard('Read-back failed', selfTest);
    $('#stopBtn').onclick = guard('Stopping the audio failed', () => { stopPlayback(); });

    const vp = $('#voicePitch'), vs = $('#voiceSpeed'), vg = $('#voiceGruff');
    const syncVoice = () => {
      state.voice = { pitch: +vp.value, speed: +vs.value, gruff: +vg.value };
      $('#voiceLabel').textContent = `pitch ${(+vp.value).toFixed(2)}× · length ${(+vs.value).toFixed(2)}× · rasp ${(+vg.value).toFixed(2)}×`;
    };
    [vp, vs, vg].forEach(el => el.addEventListener('input', syncVoice));
    $('#voiceRandom').onclick = () => {
      vp.value = (0.82 + Math.random() * 0.42).toFixed(2);
      vs.value = (0.85 + Math.random() * 0.4).toFixed(2);
      vg.value = (0.8 + Math.random() * 0.6).toFixed(2);
      syncVoice();
      const rb = $('#voiceRandom');
      if (rb.animate) rb.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 400 });
    };
    syncVoice();

    initChrome();

    drawLevel(0);
    guard('Starting up failed', doEncode)();
    $('#bootNotice').classList.add('hidden');
    reportVisitorAddress();

    /* Anything that escapes a handler from anywhere else still gets said out
       loud rather than swallowed by the console. */
    g.addEventListener('error', (e) => {
      if (e && e.message) reportProblem('Something went wrong', e.error || e.message);
    });
    g.addEventListener('unhandledrejection', (e) => {
      const reason = e && e.reason;
      reportProblem('Something went wrong', reason || 'unhandled rejection');
    });
  }

  /* -------------------------------------------------------- visitor address */
  /**
   * Tell the server which public address this browser has, when the server says
   * it cannot see one.
   *
   * Behind a router, a container network or a proxy that rewrites addresses, the
   * address the server receives belongs to the middlebox, and no amount of
   * header reading recovers the visitor's own. The browser is the only party
   * that can find out: it asks a public "what is my address?" service and sends
   * the answer back to the page's own origin. The server decides whether to ask
   * (it says so in the runtime config), names the services to use, and accepts
   * only a real public address — so the bundle itself knows nothing about any
   * outside service, works offline, and does none of this when opened from disk.
   *
   * Runs once per page, quietly, and every failure is ignored: this is a
   * best-effort improvement to a stat, and it must never disturb the app.
   */
  function reportVisitorAddress() {
    const box = doc.el.getElementById('meow-runtime');
    if (!box || !g.location || /^file:/.test(g.location.protocol)) return;
    let cfg = null;
    try { cfg = JSON.parse(box.textContent || '{}'); } catch (e) { cfg = null; }
    if (!cfg || !cfg.report || !cfg.post || !Array.isArray(cfg.endpoints) || !cfg.endpoints.length) return;
    if (!g.fetch) return;

    const askOnce = (url, timeoutMs) => new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      const timer = g.setTimeout(() => finish(null), timeoutMs);
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        if (ctl) g.setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeoutMs);
        g.fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctl && ctl.signal })
          .then(r => (r.ok ? r.json() : null))
          .then(j => {
            g.clearTimeout(timer);
            /* providers disagree on the field name; take the first that looks
               like an address */
            const guess = j && (j.ip || j.query || j.address || (j.ip_address) ||
              (j.ipv4 && j.ipv4.address) || (typeof j === 'string' ? j : null));
            finish(typeof guess === 'string' && guess.length <= 64 ? guess : null);
          })
          .catch(() => { g.clearTimeout(timer); finish(null); });
      } catch (err) { g.clearTimeout(timer); finish(null); }
    });

    const step = (i) => {
      if (i >= cfg.endpoints.length) return;
      askOnce(cfg.endpoints[i], 6000).then((ip) => {
        if (!ip) return step(i + 1);
        const post = (body) => g.fetch(cfg.post, {
          method: 'POST',
          mode: 'same-origin',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null);
        const body = { ip: ip, source: 'browser' };
        /* the modern API answers both families at once; prefer the v4 address
           when a provider hands one over, because geolocation for it is far more
           reliable than for a v6 allocation */
        post(body).then((res) => {
          if (res && res.ok) return;
          if (body.ip4 && body.ip !== body.ip4) return post({ ip: body.ip4, source: 'browser' });
          return null;
        }).catch(() => {});
      }).catch(() => {});
    };
    /* never in the way of the first paint */
    g.setTimeout(() => { try { step(0); } catch (e) { /* a stat is not worth an error */ } }, 1200);
  }

  /**
   * The parts of the interface that only exist to present things: the direction
   * control on compact widths, the title that appears once the large one has
   * scrolled under the bar, and the sheet. Each one is progressive: if any of it
   * is missing the app still works, which is what the tests rely on.
   */
  function initChrome() {
    /* direction: a segmented control that swaps panes where there is only room
       for one of them. On wide screens both panes are visible and this is hidden. */
    const segs = $$('.segmented__item');
    const panes = { A: $('#paneA'), B: $('#paneB') };
    const showPane = (which) => {
      for (const s of segs) s.setAttribute('aria-checked', String(s.dataset.pane === which));
      for (const [k, el] of Object.entries(panes)) if (el) el.classList.toggle('is-current', k === which);
    };
    for (const s of segs) s.addEventListener('click', () => showPane(s.dataset.pane || 'A'));
    if (segs.length && panes.A && panes.B) showPane('A');

    /* the bar's title fades in as the large title scrolls away */
    const nav = $('#nav'), hero = $('#hero');
    if (nav && hero && 'IntersectionObserver' in g) {
      const io = new g.IntersectionObserver((entries) => {
        for (const e of entries) nav.classList.toggle('is-scrolled', !e.isIntersecting);
      }, { rootMargin: '-12px 0px 0px 0px' });
      io.observe(hero);
    }

    /* how it works, as a sheet */
    const sheet = $('#howSheet');
    const open = $('#howBtn'), close = $('#howClose');
    const canModal = sheet && typeof sheet.showModal === 'function';
    if (canModal) {
      if (open) open.addEventListener('click', () => sheet.showModal());
      if (close) close.addEventListener('click', () => sheet.close());
      /* the backdrop is part of the sheet: a click outside closes it */
      sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
    } else if (sheet) {
      /* No <dialog> in this browser: keep the content reachable as ordinary
         markup that the button opens and the close control puts away, rather
         than losing the explanation altogether. */
      const toggle = (on) => { if (on) sheet.setAttribute('open', ''); else sheet.removeAttribute('open'); };
      if (open) open.addEventListener('click', () => toggle(true));
      if (close) close.addEventListener('click', () => toggle(false));
      sheet.addEventListener('click', (e) => { if (e.target === sheet) toggle(false); });
      toggle(true);
    }
  }

  function doEncode() {
    const text = $('#englishIn').value;
    if (!text.trim()) {
      note('Type a sentence first — or tap one of the examples above.');
      renderMeowCard(MEOW_ENGINE.encode(''));
      return;
    }
    const enc = MEOW_ENGINE.encode(text);
    const chips = renderMeowCard(enc);
    state.lastEnc = enc;
    if (!enc.tokens.length) {
      note('None of those words are in the meow lexicon yet — no meow was made.');
      return;
    }
    note('');
    const buf = bufferForTokens(enc.tokens, state.voice);
    state.lastBuffer = buf;
    state.lastBufferTokens = enc.tokens;
    checkSelfTest();
    drawWave(buf);
    /* Pressing Translate is a gesture, and the point of the button is to hear
       the cat: speak it here rather than making the reader find a second button.
       If this browser will not play audio, say that instead of going quiet. */
    if (buf) {
      const played = playBuffer(buf, (p) => {
        const n = chips.length;
        if (!n) return;
        const idx = Math.min(n - 1, Math.floor(p * n));
        chips.forEach((c, i) => c.classList.toggle('active', i === idx));
        if (p >= 1) chips.forEach(c => c.classList.remove('active'));
      });
      if (played === false) note('This browser will not play audio, but the meow text above is yours.', true);
    } else {
      note('Audio is unavailable in this browser (' + (audioUnavailable() || 'no Web Audio') + '). The meow text above is still correct.', true);
    }
  }

  /** One line of feedback directly under the buttons. */
  function note(text, warn) {
    const el = $('#encodeNote');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('warn', !!warn);
  }

  g.MEOW_APP = { init, state, bufferForTokens, recognise, playBuffer, diagnostics, reportProblem };
})(typeof globalThis !== 'undefined' ? globalThis : window);
