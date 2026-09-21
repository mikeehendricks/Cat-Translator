#!/usr/bin/env node
/* ============================================================================
   The admin panel, driven the way an operator drives it.

   tools/test-server.mjs exercises the panel's API; this exercises the panel.
   The difference matters: a template that references a variable which does not
   exist in that function renders a tab as a blank nothing, the HTTP status is
   still 200, every API check still passes, and the operator is left looking at
   an empty screen. That is exactly what happened to the Settings tab, so the
   page is now loaded in jsdom, signed into through its own form, and every tab
   is opened and read.

   It runs against its own throwaway installation, so it needs nothing running.
   ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-panel-'));
const DATA = path.join(TMP, 'data');
const ETC = path.join(TMP, 'etc');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ETC, { recursive: true });

const USER = 'paneladmin';
const PASS = 'panel-test-pass-2026';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? '  → ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
let serverLog = [];
async function startServer() {
  const net = await import('node:net');
  const port = await new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  fs.writeFileSync(path.join(ETC, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, appDir: ROOT, dataDir: DATA, restartMode: 'none', trustProxy: 'auto', sessionHours: 12,
  }, null, 2));
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MEOW_CONFIG: path.join(ETC, 'config.json'),
      MEOW_PORT: String(port),
      MEOW_HOST: '127.0.0.1',
      MEOW_APP_DIR: ROOT,
      MEOW_DATA_DIR: DATA,
      MEOW_RESTART_MODE: 'none',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => serverLog.push(String(d)));
  child.stderr.on('data', d => serverLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return port;
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('the panel test server never answered');
}

function stopServer() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch (e) {}
  child = null;
}

/* A browser-shaped UA is what a visitor has; a curl-ish one is what the panel
   calls bot traffic, and both are needed to see the two states of the table. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BOT_UA = 'curl/8.14.1';

(async () => {
  const PORT = await startServer();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\npanel test · ${TMP}\nserver on ${BASE}\n`);

  /* ---- first only crawler-shaped traffic, which the panel hides by default - */
  const visit = (ua) => fetch(BASE + '/', { headers: { 'user-agent': ua }, redirect: 'manual' });
  await visit(BOT_UA);
  await visit(BOT_UA);
  await sleep(300);

  /* ---- one-time registration, through the API the form uses ------------- */
  const setupToken = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8')).setup.token;
  const reg = await fetch(BASE + '/api/admin/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: USER, password: PASS, setupToken }),
  });
  check('the admin account can be created', reg.status === 200, String(reg.status));

  /* ---- load the real panel and sign in through its own form ------------- */
  let jar = '';
  const nodeFetch = async (url, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {});
    if (jar) headers.cookie = jar;
    const res = await fetch(new URL(url, BASE + '/').href, Object.assign({}, opts, { headers, redirect: 'manual' }));
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) if (/meow_admin=[^;]+/.test(c) && !/Max-Age=0/.test(c)) jar = c.split(';')[0];
    const text = await res.text();
    return {
      ok: res.ok, status: res.status,
      headers: { get: (k) => res.headers.get(k) },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  const page = await (await nodeFetch('/admin')).text();
  check('the panel page is served', /id="loginView"/.test(page) && /id="panelView"/.test(page));

  const dom = new JSDOM(page, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: BASE + '/admin',
    beforeParse(win) {
      win.fetch = nodeFetch;
      win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
      win.confirm = () => false;                       // never delete anything by accident
    },
  });
  const win = dom.window;
  const $ = (sel) => win.document.querySelector(sel);
  const text = (sel) => ($(sel) ? $(sel).textContent : '');
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(80); }
    return null;
  };
  await new Promise(r => win.addEventListener('load', r));

  const loginForm = await waitFor(() => (!$('#loginForm').classList.contains('hide') ? $('#loginForm') : null));
  check('the panel offers a sign-in form', !!loginForm);
  check('the version is on the panel before signing in', /1\.0\.\d+/.test(text('#loginVersion')), text('#loginVersion'));

  $('#logUser').value = USER;
  $('#logPass').value = PASS;
  $('#loginForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  const opened = await waitFor(() => (!$('#panelView').classList.contains('hide') ? $('#panelView') : null));
  check('signing in opens the panel', !!opened);
  const headerVersion = await waitFor(() => (/1\.0\.\d+/.test(text('#appVersion')) ? text('#appVersion') : null));
  check('the panel header carries the version', !!headerVersion && /v?1\.0\.\d+/.test(headerVersion), text('#appVersion'));

  const tab = (name) => win.document.querySelector(`#tabs button[data-tab="${name}"]`);
  const rowCount = () => win.document.querySelectorAll('#tab-visits table tbody tr').length;
  /* the address cell and the location cell, so a row can be judged on its own */
  const GeoCells = (tr) => {
    const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
    return { address: cells[1] || '', location: cells[2] || '' };
  };

  /* ---- overview ---------------------------------------------------------- */
  await waitFor(() => ($('#tab-overview').textContent.length > 200 ? true : null));
  check('the overview renders', /visits/i.test(text('#tab-overview')) && text('#tab-overview').length > 200,
    String(text('#tab-overview').length));
  check('the overview names the listening address and the proxy trust in force',
    /trusts proxy headers|proxy headers from a local proxy|socket address only/.test(text('#tab-overview')),
    text('#tab-overview').slice(0, 120));

  /* ---- visits: an all-bot table must explain itself ---------------------- */
  tab('visits').click();
  await waitFor(() => ($('#tab-visits').textContent.length > 200 ? true : null));
  check('the visits tab renders', /Filters/.test(text('#tab-visits')));
  check('the visits are counted', /2 visits|2 view/.test(text('#tab-visits')), text('#tab-visits').slice(0, 140));
  const showBots = await waitFor(() => $('#fShowBots'));
  check('a table emptied by the bot filter says so instead of looking broken', !!showBots,
    text('#tab-visits').slice(0, 200));
  if (showBots) {
    showBots.click();
    const more = await waitFor(() => (rowCount() >= 2 ? true : null));
    check('one tap brings the hidden rows into view', !!more, `${rowCount()} rows`);
  }
  /* a filter that matches nothing explains itself too */
  const applyFilter = async (patch) => {
    const day = await waitFor(() => $('#fDay'));
    if (!day) return;
    $('#fDay').value = patch.day || '';
    $('#fQ').value = patch.q || '';
    $('#fApply').click();
    await sleep(400);
  };
  await applyFilter({ q: 'nothing-matches-this' });
  check('a search that finds nothing says so', /No visit matches these filters/.test(text('#tab-visits')),
    text('#tab-visits').slice(0, 200));

  /* ---- now somebody real arrives, and reports a public address ----------- */
  const visitor = await visit(BROWSER_UA);
  const nonce = /meow_visit=([^;]+)/.exec(visitor.headers.get('set-cookie') || '');
  check('a visitor is handed the one-time nonce the report needs', !!nonce,
    String(visitor.headers.get('set-cookie')));
  const reported = await fetch(BASE + '/api/visit/ip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `meow_visit=${nonce ? nonce[1] : ''}` },
    body: JSON.stringify({ ip: '93.184.216.34', source: 'browser' }),
  });
  check('the visit accepts a public address from the visitor', reported.status === 200, String(reported.status));
  await visit(BROWSER_UA);
  await sleep(300);

  const clear = await waitFor(() => $('#fClearFilters') || $('#fReset'));
  (clear || { click() {} }).click();
  await sleep(500);
  if (win.document.querySelector('#fBots')) { win.document.querySelector('#fBots').value = '0'; }
  const reloaded = await waitFor(() => (rowCount() ? true : null));
  check('a real visitor is listed without touching the bot filter', !!reloaded, `${rowCount()} rows`);
  check('the address we could see first is kept beside the reported one',
    /saw 127\.0\.0\.1 first/.test(text('#tab-visits')), text('#tab-visits').slice(0, 200));
  check('the reported address is badged as a WAN address', /WAN/.test(text('#tab-visits')));
  check('the row says where the address came from', /reported by the visitor/i.test(text('#tab-visits')));
  /* The lookup is a third-party request made after the response, so it may land
     a moment later — or not at all on a host with no outbound access. When it
     does land it must be the reported address's location, never the middlebox's. */
  const reportedRow = () => Array.from(win.document.querySelectorAll('#tab-visits table tbody tr'))
    .find(tr => /93\.184\.216\.34/.test(tr.textContent));
  const geoLanded = await waitFor(() => {
    const tr = reportedRow();
    return tr && !/looking up/i.test(tr.textContent) && /[A-Z][a-z]/.test(tr.textContent) ? tr : null;
  }, 8000);
  if (geoLanded) {
    const cells = GeoCells(geoLanded);
    check('the location resolved is the reported address\u2019s own, not the middlebox\u2019s',
      cells.location.length > 2 && !/Local network/i.test(cells.location),
      JSON.stringify(cells));
  } else {
    console.log('  \u2013 location lookup did not answer in this run (offline host?): not asserted');
  }

  /* ---- settings: the tab that once rendered as nothing ------------------- */
  tab('settings').click();
  const trust = await waitFor(() => ($('#sTrust') ? $('#sTrust') : null));
  check('the settings tab renders', !!trust && /Visits/.test(text('#tab-settings')),
    text('#tab-settings').slice(0, 120));
  check('who may speak for the visitor is a three-way choice',
    !!trust && trust.options.length === 3, trust ? String(trust.options.length) : 'missing');
  check('the visitor report has its own switch', !!$('#sReportIp'));
  check('privacy mode is offered', !!$('#sRawIp'));
  check('the panel says where a trust choice is kept',
    /installed default; a choice made here/.test(text('#tab-settings')), text('#tab-settings').slice(0, 200));
  const storedTrust = () => JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8')).settings.trustProxy;
  const chooseTrust = async (value) => {
    /* the tab re-renders after every save, so the control is fetched each time */
    const select = await waitFor(() => ($('#sTrust') && $('#setForm') ? $('#sTrust') : null));
    if (!select) return false;
    select.value = value;
    $('#setForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
    await sleep(400);
    return true;
  };
  check('saving the choice reaches the store',
    (await chooseTrust('0')) && storedTrust() === false, JSON.stringify(storedTrust()));
  check('and can be put back',
    (await chooseTrust('auto')) && storedTrust() === 'auto', JSON.stringify(storedTrust()));
  check('a chosen value is not written into the read-only config', 
    JSON.parse(fs.readFileSync(path.join(ETC, 'config.json'), 'utf8')).trustProxy === 'auto');

  /* ---- updates, credentials, audit: opened, not blank -------------------- */
  tab('updates').click();
  await waitFor(() => ($('#tab-updates').textContent.length > 200 ? true : null));
  check('the updates tab renders', /Current version/.test(text('#tab-updates')), text('#tab-updates').slice(0, 120));
  tab('credentials').click();
  await waitFor(() => ($('#tab-credentials').textContent.length > 100 ? true : null));
  check('the credentials tab renders', /password/i.test(text('#tab-credentials')), text('#tab-credentials').slice(0, 120));
  tab('audit').click();
  await waitFor(() => ($('#tab-audit').textContent.length > 80 ? true : null));
  check('the audit tab renders', /register|sign|login/i.test(text('#tab-audit')), text('#tab-audit').slice(0, 140));

  /* no tab may have been left blank by a template error */
  const blanks = ['overview', 'visits', 'updates', 'credentials', 'settings', 'audit']
    .filter(t => text('#tab-' + t).trim().length < 40);
  check('no tab renders empty', blanks.length === 0, blanks.join(', '));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  failures:');
    for (const f of failures) console.log('   - ' + f);
    console.log('\n  server output (tail):\n' + serverLog.join('').split('\n').slice(-20).join('\n'));
  }
  stopServer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\npanel test crashed:', e && e.stack);
  console.log('server output:\n' + serverLog.join(''));
  stopServer();
  process.exit(1);
});
