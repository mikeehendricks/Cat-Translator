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
  };

  /* ------------------------------------------------------------------ audio */
  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = g.AudioContext || g.webkitAudioContext;
      ctx = new AC();
      state.master = ctx.createGain();
      state.master.gain.value = 0.9;
      state.master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** Synthesise tokens at the canonical rate and hand back an AudioBuffer. */
  function bufferForTokens(tokens, voice) {
    const c = audio();
    const sr = g.MEOW_MATCH.SR0;
    const descs = MEOW_ENGINE.describeTokens(tokens, voice);
    if (!descs.length) return null;
    const samples = MEOW_SYNTH.renderUtterance(descs, {
      sr, gap: 0.075, voicePitch: 1, voiceSpeed: 1,
    });
    const buf = c.createBuffer(1, samples.length, sr);
    buf.copyToChannel(samples, 0);
    return buf;
  }

  function playBuffer(buf, onProgress) {
    stopPlayback();
    const c = audio();
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
    card.classList.remove('hidden');
    card.innerHTML = '';
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
    play.className = 'primary';
    play.textContent = '▶ Say it to the cat';
    play.onclick = () => sayIt(enc.tokens, chips);
    const copy = doc.el.createElement('button');
    copy.className = 'ghost';
    copy.textContent = '⧉ Copy meow text';
    copy.onclick = () => {
      const t = enc.meow;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => { copy.textContent = '✓ Copied'; setTimeout(() => copy.textContent = '⧉ Copy meow text', 1200); });
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
      (rec.chosen.some(c => c > 0) ? ' <span class="badge ok" style="background:#9d7bff22;border-color:#9d7bff55;color:#c9b6ff">corrected</span>' : '');
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
    hint.innerHTML = rec.pitchHint ? `💡 ${rec.pitchHint}` :
      (rec.per.length > 1 ? 'tap a reading to correct it (shift-click to hear it) — the sentence updates right away' : '');
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
        status.textContent = 'thinking…';
        try {
          const arr = await blob.arrayBuffer();
          const decoded = await audio().decodeAudioData(arr.slice(0));
          const data = decoded.getChannelData(0);
          recognise(data, decoded.sampleRate, 'mic');
          status.textContent = '';
        } catch (err) {
          status.textContent = 'could not decode that recording (' + (err && err.name ? err.name : 'error') + ')';
        }
        btn.textContent = '● Record a meow';
        btn.classList.add('rec');
        checkSelfTest();
      };
      rec.start();
      state.recording = true;
      btn.textContent = '■ Stop';
      btn.classList.remove('rec');
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
      b.onclick = () => { $('#englishIn').value = ex; doEncode(); };
      box.appendChild(b);
    });

    buildPresets();
    $('#translateBtn').onclick = doEncode;
    $('#englishIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doEncode(); });
    $('#recordBtn').onclick = () => (state.recording ? stopRecording() : startRecording());
    $('#selfTest').onclick = selfTest;
    $('#stopBtn').onclick = () => { stopPlayback(); };

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

    drawLevel(0);
    doEncode();
    $('#bootNotice').classList.add('hidden');
  }

  function doEncode() {
    const text = $('#englishIn').value;
    const enc = MEOW_ENGINE.encode(text);
    const chips = renderMeowCard(enc);
    state.lastEnc = enc;
    if (enc.tokens.length) {
      const buf = bufferForTokens(enc.tokens, state.voice);
      state.lastBuffer = buf;
      state.lastBufferTokens = enc.tokens;
      checkSelfTest();
      drawWave(buf);
      chips.length;                             // chips animate when it speaks
    }
  }

  g.MEOW_APP = { init, state, bufferForTokens, recognise, playBuffer };
})(typeof globalThis !== 'undefined' ? globalThis : window);
