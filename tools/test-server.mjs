/**
 * End-to-end test of the server: install, one-time registration, visits with
 * location, credentials, settings, CSRF, rate limiting, and a REAL update +
 * rollback against a stand-in GitHub (a local HTTP server serving a tarball of
 * this very tree, with VERSION bumped), including the restart handshake.
 *
 * Run:  node tools/test-server.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-e2e-'));
const APP = path.join(TMP, 'app');
const DATA = path.join(TMP, 'data');
const ETC = path.join(TMP, 'etc');
/**
 * A crashed run used to leave its server behind, and the next run could pick the
 * same random port — so the test would drive a *stale* server from an earlier
 * workspace, with a different store. Ask the operating system for a free port
 * instead, and insist it is still free just before starting.
 */
async function freePort() {
  const net = await import('node:net');
  return await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
let PORT = 0;           /* chosen at startup, once we know the machine is quiet */
let GH_PORT = 0;
/** The version the staged tree pretends to be installed as, and the version the
 *  stand-in GitHub offers. Both are pinned here on purpose: the suite must not
 *  depend on whatever VERSION the workspace happens to carry. */
const BASE_VERSION = '1.0.0';
const REMOTE_VERSION = '1.0.1';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? '  → ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
   A host where tar is unusable.

   Some environments refuse tar's file creation outright — every entry comes
   back "tar: <path>: Cannot open: Function not implemented", which is open(2)
   returning ENOSYS — while Node writes to the same directory without complaint.
   The service is started with this shim ahead of the real tar on PATH, so the
   whole suite runs on such a host: every update and rollback below has to work
   without tar, and the shim records any attempt to use it.
   ------------------------------------------------------------------------ */
const SHIM_DIR = path.join(os.tmpdir(), `meow-shim-${process.pid}`);
const SHIM_MARKER = path.join(SHIM_DIR, 'tar-was-called');
fs.rmSync(SHIM_DIR, { recursive: true, force: true });
fs.mkdirSync(SHIM_DIR, { recursive: true });
fs.writeFileSync(path.join(SHIM_DIR, 'tar'),
  '#!/bin/sh\n' +
  `echo "$@" >> ${JSON.stringify(SHIM_MARKER)}\n` +
  'echo "tar: Cannot open: Function not implemented" >&2\n' +
  'exit 2\n', { mode: 0o755 });
const tarCalls = () => (fs.existsSync(SHIM_MARKER) ? fs.readFileSync(SHIM_MARKER, 'utf8').trim().split('\n').length : 0);

/* --------------------------------------------------------------- stand-in GitHub */

function buildTarball(version, sha) {
  /* a copy of this tree with VERSION bumped and a visible marker, tarred exactly
     like codeload does: one top-level directory carrying the commit sha */
  const work = path.join(TMP, `payload-${version}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const top = path.join(work, `Cat-Translator-${sha}`);
  const r = spawnSync('bash', ['-c', `mkdir -p ${JSON.stringify(top)} && cd ${JSON.stringify(ROOT)} && tar --exclude=.git --exclude=node_modules --exclude=data --exclude=.npm --exclude=.cache --exclude=.local --exclude=.arena -cf - . | (cd ${JSON.stringify(top)} && tar -xf -)`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('copy failed: ' + r.stderr);
  fs.writeFileSync(path.join(top, 'VERSION'), version + '\n');
  const appFile = path.join(top, 'cat-translator.html');
  let html = fs.readFileSync(appFile, 'utf8').replace(/version \d+\.\d+\.\d+/g, 'version ' + version);
  fs.writeFileSync(appFile, html);
  const tar = path.join(work, 'payload.tar.gz');
  const t = spawnSync('tar', ['-czf', tar, '-C', work, `Cat-Translator-${sha}`], { encoding: 'utf8' });
  if (t.status !== 0) throw new Error('tar failed: ' + t.stderr);
  return fs.readFileSync(tar);
}

const REMOTE_SHA = crypto.randomBytes(20).toString('hex');
let remoteTarball = null;
let remoteVersion = REMOTE_VERSION;
let remoteHits = [];
let failDownloads = false;

function startFakeGitHub() {
  const server = http.createServer((req, res) => {
    remoteHits.push(req.url);
    const u = new URL(req.url, `http://127.0.0.1:${GH_PORT}`);
    if (failDownloads && /tarball|tar\.gz/.test(u.pathname)) { res.writeHead(500); return res.end('boom'); }
    if (/^\/repos\/([^/]+)\/([^/]+)\/commits\//.test(u.pathname)) {
      return json(res, 200, {
        sha: REMOTE_SHA,
        commit: { message: `Release ${remoteVersion}\n\nnotes here`, committer: { date: new Date().toISOString() } },
      });
    }
    if (/^\/repos\/([^/]+)\/([^/]+)\/contents\/VERSION/.test(u.pathname)) {
      return json(res, 200, { content: Buffer.from(remoteVersion + '\n').toString('base64'), encoding: 'base64' });
    }
    if (/tarball/.test(u.pathname) || /tar\.gz/.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(remoteTarball);
    }
    if (/VERSION$/.test(u.pathname)) { res.writeHead(200); return res.end(remoteVersion + '\n'); }
    res.writeHead(404); res.end('not found');
  });
  return new Promise(resolve => server.listen(GH_PORT, '127.0.0.1', () => resolve(server)));
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/* ------------------------------------------------------------------ server harness */

let child = null;
let serverOutput = [];

function startServer(extraEnv) {
  child = spawn(process.execPath, [path.join(APP, 'server', 'server.js')], {
    cwd: APP,
    env: Object.assign({}, process.env, {
      MEOW_CONFIG: path.join(ETC, 'config.json'),
      MEOW_PORT: String(PORT),
      MEOW_HOST: '127.0.0.1',
      MEOW_APP_DIR: APP,
      MEOW_DATA_DIR: DATA,
      MEOW_RESTART_MODE: 'exec',
      MEOW_GITHUB_API: `http://127.0.0.1:${GH_PORT}`,
      MEOW_GITHUB_RAW: `http://127.0.0.1:${GH_PORT}`,
      MEOW_GITHUB_TAR: `http://127.0.0.1:${GH_PORT}`,
      /* the shim comes first: this service runs on a host where tar fails */
      PATH: `${SHIM_DIR}:${process.env.PATH || ''}`,
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => serverOutput.push(String(d)));
  child.stderr.on('data', d => serverOutput.push(String(d)));
  return child;
}

async function stopServer() {
  if (!child) return;
  const pid = child.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
  await sleep(300);
  try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  child = null;
}

const BASE = () => `http://127.0.0.1:${PORT}`;
async function get(pathname, opts) {
  const res = await fetch(BASE() + pathname, Object.assign({ redirect: 'manual' }, opts));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body, res, headers: res.headers };
}

let cookies = '';
function setCookie(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of sc) {
    if (/meow_admin=;/.test(c) || /Max-Age=0/.test(c)) { cookies = ''; continue; }
    cookies = c.split(';')[0];
  }
}
const authed = (extra) => Object.assign({ headers: Object.assign({ cookie: cookies }, (extra && extra.headers) || {}) }, extra);
let csrf = '';

async function post(pathname, body, opts) {
  const o = Object.assign({}, opts || {});
  const headers = Object.assign({ 'content-type': 'application/json', cookie: cookies }, (o.headers || {}));
  if (csrf) headers['x-meow-csrf'] = csrf;
  const res = await fetch(BASE() + pathname, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
  if (res.headers.get('set-cookie')) setCookie(res);
  return { status: res.status, body: parsed, headers: res.headers, res };
}

/** Wait until a DIFFERENT process answers, i.e. the restart really happened.
 *  (The dying process keeps serving for a moment; uptime is not a reliable
 *  signal because a fresh process reports 0.) */
async function waitForFreshHealth(prevInstanceId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE() + '/api/health');
      if (r.ok) {
        const h = await r.json();
        if (!prevInstanceId || (h.instanceId && h.instanceId !== prevInstanceId)) return h;
      }
    } catch (e) { /* still down */ }
    await sleep(400);
  }
  return null;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE() + '/api/health');
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(400);
  }
  return null;
}

/* ------------------------------------------------------------------------ main */

(async () => {
  PORT = await freePort();
  GH_PORT = PORT + 1;
  console.log(`\n\x1b[1mMeow translator server test\x1b[0m   workspace ${TMP}   port ${PORT}\n`);

  /* ---- 0. stage an "installed" tree --------------------------------------- */
  fs.mkdirSync(APP, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(ETC, { recursive: true });
  const copy = spawnSync('bash', ['-c', `cd ${JSON.stringify(ROOT)} && tar --exclude=.git --exclude=node_modules --exclude=data --exclude=.npm --exclude=.cache --exclude=.local --exclude=.arena -cf - . | (cd ${JSON.stringify(APP)} && tar -xf -)`]);
  check('staged a copy of the tree for the test', copy.status === 0);
  /* the staged tree is the "already installed" release, so it says so */
  fs.writeFileSync(path.join(APP, 'VERSION'), BASE_VERSION + '\n');
  fs.writeFileSync(path.join(ETC, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: PORT, appDir: APP, dataDir: DATA, restartMode: 'exec', trustProxy: 'auto', sessionHours: 12,
  }, null, 2));

  /* ---- 0b. the shipped selftest must pass on a clean tree ----------------- */
  const st = spawnSync(process.execPath, [path.join(APP, 'server', 'selftest.js')], { cwd: APP, encoding: 'utf8', env: Object.assign({}, process.env, { MEOW_APP_DIR: APP }) });
  check('selftest passes on the tree', st.status === 0, (st.stdout + st.stderr).trim().slice(0, 200));

  /* ---- 0c. install.sh syntax --------------------------------------------- */
  const bashCheck = spawnSync('bash', ['-n', path.join(APP, 'install.sh')], { encoding: 'utf8' });
  check('install.sh parses (bash -n)', bashCheck.status === 0, bashCheck.stderr.trim());

  /* A local install must copy the application and not a data directory that
     happens to sit inside the source tree. It once copied its own output back
     into itself until the disk was full, so the exclusion list is exercised
     here for real, with the same flags the installer uses. */
  {
    const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const excludes = (script.match(/--exclude='\.\/[^']+'/g) || []);
    check('the installer excludes runtime state and caches from a local install',
      excludes.includes("--exclude='./data'") && excludes.includes("--exclude='./node_modules'") &&
      excludes.includes("--exclude='./.git'") && excludes.length >= 8,
      excludes.join(' '));
    check('the installer refuses a payload far larger than the application',
      /STAGE_KB/.test(script) && /-gt 262144/.test(script));

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-stage-'));
    const src = path.join(scratch, 'src'), out = path.join(scratch, 'out');
    fs.mkdirSync(path.join(src, 'server'), { recursive: true });
    fs.mkdirSync(path.join(src, 'data', 'versions', 'install-old'), { recursive: true });
    fs.writeFileSync(path.join(src, 'server', 'server.js'), '// app\n');
    fs.writeFileSync(path.join(src, 'VERSION'), '9.9.9\n');
    fs.writeFileSync(path.join(src, 'data', 'store.json'), '{"big":true}\n');
    fs.writeFileSync(path.join(src, 'data', 'versions', 'install-old', 'copy.js'), '// old install\n');
    fs.mkdirSync(out, { recursive: true });
    const tarFlags = excludes.map(e => e.replace(/^--exclude='\.\//, "--exclude='./"));
    const copy = spawnSync('bash', ['-c',
      `tar -C ${JSON.stringify(src)} ${tarFlags.join(' ')} -cf - . | tar -C ${JSON.stringify(out)} -xf -`]);
    check('a staged local copy leaves the data directory behind', copy.status === 0 &&
      !fs.existsSync(path.join(out, 'data')) && fs.existsSync(path.join(out, 'server', 'server.js')));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const unCheck = spawnSync('bash', ['-n', path.join(APP, 'uninstall.sh')], { encoding: 'utf8' });
  /* Packaging guard. These files are meant to be run, and a tree that lost its
     executable bits (a checkout that normalised permissions, a copy that did
     not preserve them) would ship a package where `./install.sh` fails with
     "permission denied" — after the download, for the person least able to
     guess why. */
  {
    const shouldRun = ['install.sh', 'uninstall.sh', path.join('bin', 'meow-translator'),
      path.join('tools', 'test-server.mjs'), path.join('tools', 'test-archive.mjs')];
    const notExecutable = shouldRun.filter(f => {
      try { return (fs.statSync(path.join(APP, f)).mode & 0o111) === 0; } catch (e) { return false; }
    });
    check('the scripts that have to run are executable', notExecutable.length === 0,
      notExecutable.join(', ') + ' — run: chmod +x ' + notExecutable.join(' '));
  }

  check('uninstall.sh parses (bash -n)', unCheck.status === 0, unCheck.stderr.trim());
  const cli = fs.readFileSync(path.join(APP, 'bin', 'meow-translator'), 'utf8');
  const cliSyntax = spawnSync(process.execPath, ['--check', path.join(APP, 'bin', 'meow-translator')], { encoding: 'utf8' });
  check('meow-translator CLI parses', cliSyntax.status === 0, cliSyntax.stderr.trim());

  /* ---- 1. boot ------------------------------------------------------------ */
  /* nothing may be listening yet: a leftover server here means the whole run
     would be talking to somebody else's store */
  const net = await import('node:net');
  for (const p of [PORT, GH_PORT]) {
    const taken = await new Promise(resolve => {
      const srv = net.createServer();
      srv.once('error', () => resolve(true));
      srv.once('listening', () => srv.close(() => resolve(false)));
      srv.listen(p, '127.0.0.1');
    });
    if (taken) {
      console.error(`\n  port ${p} is already in use — a server from an earlier test run is still alive.`);
      console.error('  find it with:  ps -eo pid,args | grep server.js   then kill that pid\n');
      process.exit(2);
    }
  }
  remoteTarball = buildTarball(REMOTE_VERSION, REMOTE_SHA);
  const gh = await startFakeGitHub();
  startServer();
  const health = await waitForHealth(20000);
  check('server starts and answers /api/health', !!health && !!health.instanceId, 'no health response');
  check('health reports the installed version', health && health.version === BASE_VERSION, health && health.version);

  /* ---- 2. the app is served ---------------------------------------------- */
  const page = await get('/');
  check('GET / serves the translator app', page.status === 200 && /MEOW_APP/.test(page.body));
  check('the page carries a Content-Security-Policy', !!page.headers.get('content-security-policy'));
  const ver = await get('/api/version');
  check('GET /api/version returns a version', ver.body && ver.body.version === BASE_VERSION, JSON.stringify(ver.body));

  /* ---- 3. one-time registration ----------------------------------------- */
  const admin = await get('/admin');
  check('GET /admin serves the panel', admin.status === 200 && /id="loginView"/.test(admin.body));
  check('the panel arrives with the shared design system inlined',
    /--t-large-title/.test(admin.body) && /prefers-reduced-motion/.test(admin.body) &&
    /--tint:\s*#007aff/.test(admin.body));
  check('the panel arrives with the symbol sprite inlined',
    /<symbol id="i-/.test(admin.body) && /<use href="#i-/.test(admin.body));
  check('the panel fetches nothing from outside',
    !/(src|href)\s*=\s*["']https?:/i.test(admin.body) &&
    !/fetch\(\s*["']https?:/i.test(admin.body) &&
    !/__MEOW_(DESIGN|SYMBOLS)__/.test(admin.body));

  const badToken = await post('/api/admin/register', { username: 'mike', password: 'meow-meow-123', setupToken: 'nope' });
  check('registration with a wrong setup token is refused', badToken.status === 403, JSON.stringify(badToken.body));

  const storePath = path.join(DATA, 'store.json');
  const token = JSON.parse(fs.readFileSync(storePath, 'utf8')).setup.token;
  const weak = await post('/api/admin/register', { username: 'mike', password: 'short', setupToken: token });
  check('registration enforces the password policy', weak.status === 400, JSON.stringify(weak.body));

  const reg = await post('/api/admin/register', { username: 'mike', password: 'meow-meow-123', setupToken: token });
  check('registration succeeds with the right token', reg.status === 200 && reg.body.session, JSON.stringify(reg.body).slice(0, 160));
  setCookie(reg.res);
  csrf = reg.body.session && reg.body.session.csrf;
  check('session cookie is HttpOnly + SameSite=Strict', /HttpOnly/.test(reg.res.headers.get('set-cookie') || '') && /SameSite=Strict/.test(reg.res.headers.get('set-cookie') || ''));

  const again = await post('/api/admin/register', { username: 'someoneelse', password: 'meow-meow-123', setupToken: token });
  check('registration is one-time (second attempt refused)', again.status === 409, JSON.stringify(again.body));

  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('the setup token is marked used', stored.setup.used === true);
  check('the password is not stored in clear', !JSON.stringify(stored).includes('meow-meow-123'));

  /* ---- 4. session + admin API ------------------------------------------- */
  const sess = await get('/api/admin/session', { headers: { cookie: cookies } });
  check('session endpoint works with the cookie', sess.status === 200 && sess.body.admin.username === 'mike', JSON.stringify(sess.body).slice(0, 120));
  check('app version is on the admin session payload', sess.body.app && sess.body.app.version === BASE_VERSION);

  /* ---- 5. visits + location --------------------------------------------- */
  for (let i = 0; i < 3; i++) await fetch(BASE() + '/');
  await sleep(600);
  const visits = await get('/api/admin/visits?limit=50', { headers: { cookie: cookies } });
  check('visit log recorded the page views', visits.body.total >= 4, String(visits.body.total));
  const row = visits.body.rows[0];
  check('a visit row carries an ip address', row && (row.ip === '127.0.0.1' || row.ip === '::1'), row && row.ip);
  check('local addresses are labelled "Local network"', row && row.geo && row.geo.local === true, JSON.stringify(row && row.geo));
  check('user agent is stored', row && /node/i.test(row.ua || ''), row && row.ua);
  check('daily series is present', visits.body.summary.series.length === 30);
  const csv = await get('/api/admin/visits.csv', { headers: { cookie: cookies } });
  check('CSV export works', csv.status === 200 && /time_iso,unix,ip/.test(csv.body), String(csv.body).slice(0, 60));

  /* ---- 6. CSRF and origin gates ---------------------------------------- */
  const noCsrf = await fetch(BASE() + '/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies }, body: '{}',
  });
  check('a POST without the CSRF token is refused', noCsrf.status === 403, String(noCsrf.status));
  const crossOrigin = await fetch(BASE() + '/api/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies, 'x-meow-csrf': csrf, origin: 'http://evil.example' },
    body: '{}',
  });
  check('a cross-origin POST is refused', crossOrigin.status === 403, String(crossOrigin.status));

  /* ---- 7. settings round trip ------------------------------------------ */
  const setRes = await post('/api/admin/settings', { retentionDays: 30, geoLookup: false, githubRepo: 'mikeehendricks/Cat-Translator', updateChannel: 'main' });
  check('settings save', setRes.status === 200 && setRes.body.settings.retentionDays === 30, JSON.stringify(setRes.body).slice(0, 120));
  const settingsReload = await get('/api/admin/overview', { headers: { cookie: cookies } });
  check('settings persist across requests', settingsReload.body.settings.retentionDays === 30);

  /* ---- 8. update check + install + restart + rollback ------------------- */
  const checkRes = await post('/api/admin/updates/check', {});
  check('update check finds the remote version', checkRes.body.remote && checkRes.body.remote.version === REMOTE_VERSION,
    JSON.stringify(checkRes.body).slice(0, 200));
  check('update check flags it as newer', checkRes.body.updateAvailable === true && checkRes.body.newer === true);

  const beforeUpdate = await waitForHealth(5000);
  const updRes = await post('/api/admin/updates/install', { sha: REMOTE_SHA, version: REMOTE_VERSION });
  check('update install reports success', updRes.status === 200 && updRes.body.ok === true, JSON.stringify(updRes.body).slice(0, 200));
  check('update reports the new version', updRes.body.version === REMOTE_VERSION, updRes.body.version);
  check('update snapshotted the previous version', updRes.body.backupTaken === true);
  check('the version file on disk was updated', fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim() === REMOTE_VERSION);
  check('the update did not need tar (the shim was never called)', tarCalls() === 0,
    tarCalls() + ' call(s): ' + (fs.existsSync(SHIM_MARKER) ? fs.readFileSync(SHIM_MARKER, 'utf8').trim() : ''));
  /* the updater logs into the store, which is what the panel shows */
  const updateLog = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8')).updateLog || [];
  check('the update log says the archive was unpacked with the built-in reader',
    updateLog.some(l => /built-in reader/.test(l.message)),
    updateLog.slice(-4).map(l => l.level + ': ' + l.message).join(' | ').slice(0, 220));

  const back = await waitForFreshHealth(beforeUpdate && beforeUpdate.instanceId, 45000);
  check('the service came back after the update (self-restart)', !!back,
    `instance ${beforeUpdate && beforeUpdate.instanceId}; output: ` + serverOutput.join('').slice(-200));
  check('the restarted service runs the new version', back && back.version === REMOTE_VERSION, back && back.version);
  const servedAfter = await get('/api/version');
  check('the public version endpoint reports the new version', servedAfter.body.version === REMOTE_VERSION);

  const history = await post('/api/admin/updates/check', {});   // re-auth context is unchanged: session survives
  const histRes = await get('/api/admin/updates', { headers: { cookie: cookies } });
  check('update history lists both versions', histRes.body.history.length >= 2, JSON.stringify(histRes.body.history.map(h => h.version)));
  /* the newest snapshot is the pre-update state — the version you would roll
     back TO. Labelling it "running" would point the operator at the wrong row. */
  check('the newest snapshot is not labelled as the running version',
    histRes.body.history[0].current === false,
    'history[0] is v' + histRes.body.history[0].version + ' current=' + histRes.body.history[0].current +
    ' while the running version is ' + REMOTE_VERSION);
  check('a rollback target is available', histRes.body.history.some(h => h.restorable && !h.current));

  const beforeRollback = await waitForHealth(5000);
  const rb = await post('/api/admin/updates/rollback', { version: BASE_VERSION });
  check('rollback reports success', rb.status === 200 && rb.body.version === BASE_VERSION, JSON.stringify(rb.body).slice(0, 200));
  const back2 = await waitForFreshHealth(beforeRollback && beforeRollback.instanceId, 45000);
  check('tar was never needed anywhere in the suite', tarCalls() === 0, tarCalls() + ' call(s)');
  check('the rollback restarted the process', !!back2,
    `instance before ${beforeRollback && beforeRollback.instanceId}, after ${back2 && back2.instanceId}`);
  check(`the rolled-back service runs v${BASE_VERSION} again`, back2 && back2.version === BASE_VERSION, back2 && back2.version);
  check('the version file was restored', fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim() === BASE_VERSION);
  /* the restarted process does not inherit the in-memory session cookie, so sign
     in again — which is also the state an operator would be in */
  /* The replacement process is detached, and in this development restart mode a
     second replacement can briefly answer alongside the first, so give the panel
     a moment to settle before asking an authenticated question. */
  let hist2 = { status: 0, body: null };
  for (let i = 0; i < 12; i++) {
    const relog = await post('/api/admin/login', { username: 'mike', password: 'meow-meow-123' });
    if (relog.status === 200 && relog.body.session) {
      setCookie(relog.res);
      csrf = relog.body.session.csrf;      // a fresh login means a fresh CSRF token
    }
    hist2 = await get('/api/admin/updates', authed());
    if (hist2.status === 200) break;
    await sleep(500);
  }
  const flagged = (hist2.body && hist2.body.history || []).filter(h => h.current);
  check('after a rollback exactly one snapshot is flagged as running',
    flagged.length === 1 && flagged[0].version === BASE_VERSION,
    `status ${hist2.status} keys ${hist2.body && typeof hist2.body === 'object' ? Object.keys(hist2.body).join(',') : typeof hist2.body} ` +
    JSON.stringify((hist2.body && hist2.body.history || []).slice(0, 4).map(h => 'v' + h.version + ':' + h.current)));

  /* ---- 9. a failed update must not touch the live tree ------------------ */
  failDownloads = true;
  const broken = await post('/api/admin/updates/install', { sha: REMOTE_SHA, version: REMOTE_VERSION });
  failDownloads = false;
  check('a failed download is reported as an error', broken.status === 500 && /download/i.test(broken.body.error || ''), JSON.stringify(broken.body).slice(0, 160));
  check('the live version is untouched by the failure', fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim() === BASE_VERSION);
  const stillUp = await waitForHealth(5000);
  check('the service kept running through the failure', !!stillUp);

  /* ---- 10. credentials -------------------------------------------------- */
  const wrongPw = await post('/api/admin/credentials', { currentPassword: 'nope', newPassword: 'another-pass-9' });
  check('changing credentials needs the current password', wrongPw.status === 403);
  const pwChange = await post('/api/admin/credentials', { currentPassword: 'meow-meow-123', newPassword: 'another-pass-9' });
  check('password change succeeds', pwChange.status === 200, JSON.stringify(pwChange.body));
  const oldLogin = await post('/api/admin/login', { username: 'mike', password: 'meow-meow-123' });
  check('the old password no longer works', oldLogin.status === 401);
  const newLogin = await post('/api/admin/login', { username: 'mike', password: 'another-pass-9' });
  check('the new password works', newLogin.status === 200);
  setCookie(newLogin.res);
  csrf = newLogin.body.session.csrf;

  const userChange = await post('/api/admin/credentials', { username: 'michael', currentPassword: 'another-pass-9' });
  check('username change succeeds', userChange.status === 200 && userChange.body.username === 'michael', JSON.stringify(userChange.body));

  /* ---- 11. login throttling -------------------------------------------- */
  const lockIp = '203.0.113.9';
  const spoof = { headers: { 'x-forwarded-for': lockIp } };
  let lastStatus = 0, lastBody = '';
  for (let i = 0; i < 12; i++) {
    const r = await fetch(BASE() + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': lockIp },
      body: JSON.stringify({ username: 'michael', password: 'wrong-' + i }),
    });
    lastStatus = r.status;
    lastBody = await r.text();
    if (r.status === 429) break;
  }
  check('repeated wrong passwords lock the account out', lastStatus === 429 && /failed attempts/.test(lastBody),
    `status ${lastStatus}: ${lastBody.slice(0, 120)}`);

  /* ---- 12. audit log ---------------------------------------------------- */
  const audit = await get('/api/admin/audit', { headers: { cookie: cookies } });
  const actions = (audit.body.rows || []).map(r => r.action);
  check('audit log recorded the important events',
    ['register', 'update-install', 'rollback', 'credentials-changed', 'login-failed'].every(a => actions.includes(a)),
    actions.slice(0, 12).join(','));

  /* ---- 13. the standalone CLI ------------------------------------------ */
  const cliStatus = spawnSync(process.execPath, [path.join(APP, 'bin', 'meow-translator'), 'status'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MEOW_CONFIG: path.join(ETC, 'config.json'), MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA }),
  });
  check('CLI status runs and shows the version', cliStatus.status === 0 && new RegExp('installed version\\s+v' + BASE_VERSION.replace(/\./g, '\\.')).test(cliStatus.stdout),
    (cliStatus.stdout + cliStatus.stderr).slice(0, 200));
  const cliVersions = spawnSync(process.execPath, [path.join(APP, 'bin', 'meow-translator'), 'versions'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MEOW_CONFIG: path.join(ETC, 'config.json'), MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA }),
  });
  check('CLI versions lists history', cliVersions.status === 0 && cliVersions.stdout.includes('v' + BASE_VERSION));

  /* net-check is the "why can't I reach it from my laptop" command. The test
     installation is deliberately on 127.0.0.1, so it must say so. */
  const cliNet = spawnSync(process.execPath, [path.join(APP, 'bin', 'meow-translator'), 'net-check'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA, MEOW_CONFIG: path.join(ETC, 'config.json') }),
  });
  const netOut = cliNet.stdout || '';
  check('CLI net-check names a loopback-only bind',
    netOut.includes('reachable only from this machine') && netOut.includes('config --host 0.0.0.0'),
    netOut.split('\n').filter(l => /listens on|!--|! /.test(l)).slice(0, 2).join(' ').trim().slice(0, 160));
  const cliToken = spawnSync(process.execPath, [path.join(APP, 'bin', 'meow-translator'), 'token'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MEOW_CONFIG: path.join(ETC, 'config.json'), MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA }),
  });
  check('CLI token reports that registration is done', /Registration is already complete/.test(cliToken.stdout), cliToken.stdout.slice(0, 120));

  /* ---- 14. privacy mode ------------------------------------------------- */
  const privacySet = await post('/api/admin/settings', { storeRawIp: false });
  check('privacy setting saves', privacySet.status === 200 && privacySet.body.settings.storeRawIp === false,
    JSON.stringify(privacySet.body).slice(0, 120));
  await fetch(BASE() + '/');
  await sleep(600);
  const afterPrivacy = await get('/api/admin/visits?limit=50', { headers: { cookie: cookies } });
  const newest = afterPrivacy.body.rows[0] || {};
  check('the panel is told privacy mode is on', afterPrivacy.body.privacyMode === true);
  check('new visits store no address in privacy mode', !newest.ip && !!newest.hash,
    JSON.stringify(newest).slice(0, 140));
  check('visits recorded earlier keep the address they came with',
    afterPrivacy.body.rows.some(r => r.ip === '127.0.0.1'));
  await post('/api/admin/settings', { storeRawIp: true });
  const backOn = await get('/api/admin/overview', { headers: { cookie: cookies } });
  check('privacy mode can be turned back off', backOn.body.settings.storeRawIp === true);


  /* ---- 15. the visitor's real (WAN) address ----------------------------- */
  /* Two failure modes are worth guarding here. Believing the forwarding
     headers from anyone turns the visit log into a visitor-written field; and
     showing a router's or container's address as if it were the visitor's is
     the complaint that started this. Both are decided in server/lib/clientip.js,
     so most of it is testable without a socket. */
  const clientip = await import(path.join(APP, 'server', 'lib', 'clientip.js'));
  const reqFrom = (peer, headers) => ({ socket: { remoteAddress: peer }, headers: headers || {} });
  const AUTO = { trustProxy: 'auto', trustedProxies: [] };

  const stranger = clientip.resolve(reqFrom('203.0.113.7', {
    'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8', 'x-real-ip': '9.9.9.9',
  }), AUTO);
  check('a stranger cannot write their own address into the log',
    stranger.ip === '203.0.113.7' && stranger.source === 'socket', JSON.stringify(stranger));

  const viaNginx = clientip.resolve(reqFrom('127.0.0.1', { 'x-forwarded-for': '10.0.0.4, 8.8.4.4' }), AUTO);
  check('a proxy on this machine is believed, and the right address is taken',
    viaNginx.ip === '8.8.4.4' && viaNginx.source === 'x-forwarded-for' && viaNginx.private === false,
    JSON.stringify(viaNginx));
  check('the whole hop chain is kept for the panel to show',
    JSON.stringify(viaNginx.chain) === JSON.stringify(['127.0.0.1', '10.0.0.4', '8.8.4.4']),
    JSON.stringify(viaNginx.chain));

  const named = clientip.resolve(reqFrom('127.0.0.1', {
    'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '1.2.3.4',
  }), AUTO);
  check('a CDN header that names the client outright wins', named.ip === '8.8.8.8' && named.source === 'cloudflare',
    JSON.stringify(named));

  const forwarded = clientip.resolve(reqFrom('127.0.0.1', { forwarded: 'for="9.9.9.9";proto=https' }), AUTO);
  check('the RFC 7239 Forwarded header is understood', forwarded.ip === '9.9.9.9' && forwarded.source === 'forwarded',
    JSON.stringify(forwarded));

  const forced = clientip.resolve(reqFrom('127.0.0.1', { 'x-forwarded-for': '8.8.4.4' }), { trustProxy: false });
  check('turning proxy trust off falls back to the connecting address',
    forced.ip === '127.0.0.1' && forced.source === 'socket', JSON.stringify(forced));

  const trusted = clientip.resolve(reqFrom('203.0.113.7', { 'x-forwarded-for': '8.8.4.4' }), { trustProxy: true });
  check('a proxy somewhere else can be trusted explicitly',
    trusted.ip === '8.8.4.4' && trusted.source === 'x-forwarded-for', JSON.stringify(trusted));

  const cidr = clientip.resolve(reqFrom('198.51.100.9', { 'x-real-ip': '8.8.4.4' }),
    { trustProxy: 'auto', trustedProxies: ['198.51.100.0/24'] });
  check('a proxy named by address range is believed',
    cidr.ip === '8.8.4.4' && cidr.source === 'x-real-ip', JSON.stringify(cidr));
  check('CIDR matching is not a prefix match',
    clientip.inCidr('198.51.100.9', '198.51.100.0/24') === true &&
    clientip.inCidr('198.51.101.9', '198.51.100.0/24') === false &&
    clientip.inCidr('10.4.3.2', '10.0.0.0/8') === true);

  const lan = clientip.resolve(reqFrom('192.168.1.50'), AUTO);
  check('an address out of the router is flagged as private, not shown as a visitor',
    lan.private === true && lan.source === 'socket', JSON.stringify(lan));

  const dockerish = clientip.resolve(reqFrom('172.17.0.1', { 'x-forwarded-for': '8.8.4.4' }), AUTO);
  check('a container network counts as a local proxy',
    dockerish.ip === '8.8.4.4' && dockerish.private === false, JSON.stringify(dockerish));

  check('a private address is what asks the browser for the real one',
    clientip.wantsReport(lan, { reportVisitorIp: true, storeRawIp: true }) === true &&
    clientip.wantsReport({ private: false }, { reportVisitorIp: true, storeRawIp: true }) === false,
    'a public address needs no report');
  check('the report can be switched off, and privacy mode switches it off too',
    clientip.wantsReport(lan, { reportVisitorIp: false, storeRawIp: true }) === false &&
    clientip.wantsReport(lan, { reportVisitorIp: true, storeRawIp: false }) === false);

  const rejected = [
    ['', 'empty'], ['not-an-address', 'nonsense'], ['10.0.0.5', 'private'],
    ['127.0.0.1', 'loopback'], ['169.254.1.1', 'link-local'], ['192.0.2.5', 'documentation'],
    ['203.0.113.5', 'test range'], ['198.51.100.7', 'test range'], ['224.0.0.1', 'multicast'],
    ['300.1.1.1', 'out of range octet'], ['1.2.3', 'incomplete'],
  ];
  const wronglyAccepted = rejected.filter(([ip]) => clientip.validateReported(ip).ok).map(([ip]) => ip);
  check('an unusable address is refused as a report', wronglyAccepted.length === 0, wronglyAccepted.join(', '));
  const accepted = clientip.validateReported(' 8.8.4.4 ');
  check('a real public address is accepted, and normalised',
    accepted.ok === true && accepted.ip === '8.8.4.4' && accepted.family === 4, JSON.stringify(accepted));
  const v6 = clientip.validateReported('2606:4700:4700::1111');
  check('a public IPv6 address is accepted too', v6.ok === true && v6.family === 6, JSON.stringify(v6));

  /* A report re-keys the day's unique count: the visitor is one person whether
     they arrived through the router's address or their own. */
  const stats = await import(path.join(APP, 'server', 'lib', 'stats.js'));
  const fakeStore = { data: { settings: { storeRawIp: true }, dayStats: {}, visits: [] }, dirty() {}, save() {}, audit() {} };
  const ua = 'Mozilla/5.0 (iPhone) test';
  const a = stats.record(fakeStore, { ip: '192.168.1.50', path: '/', ua, ref: '', source: 'socket', chain: [] });
  const b = stats.record(fakeStore, { ip: '10.0.0.9', path: '/', ua, ref: '', source: 'socket', chain: [] });
  const dayOf = () => fakeStore.data.dayStats[stats.dayKey(Date.now())];
  check('two private visitors count as two uniques while they are unknown', dayOf().uniques === 2, String(dayOf().uniques));
  stats.rehash(fakeStore, a, '8.8.4.4');
  stats.rehash(fakeStore, b, '8.8.4.4');
  check('once both report the same public address they count as one person',
    dayOf().uniques === 1, String(dayOf().uniques));
  check('the day keeps the address it now knows them by',
    !!dayOf().seen[stats.visitorHash('8.8.4.4', ua)] && !dayOf().seen[stats.visitorHash('192.168.1.50', ua)],
    JSON.stringify(Object.keys(dayOf().seen)));

  /* The nonce ties one report to one visit, and dies with it. */
  const nonceStore = { data: { settings: { storeRawIp: true }, dayStats: {}, visits: [] }, dirty() {}, audit() {} };
  const visit = stats.record(nonceStore, { ip: '192.168.1.9', path: '/', ua, ref: '', source: 'socket', chain: [] });
  visit.reportNonce = 'a-nonce-for-one-visit';
  check('a fresh nonce is honoured', stats.byReportNonce(nonceStore, 'a-nonce-for-one-visit') === visit);
  check('an unknown nonce counts for nothing', stats.byReportNonce(nonceStore, 'made-up') === null);
  visit.t = Date.now() - 16 * 60 * 1000;
  check('an old nonce stops working', stats.byReportNonce(nonceStore, 'a-nonce-for-one-visit') === null);

  /* ...and the same thing over HTTP, which is how a visitor arrives. */
  const visitorRes = await fetch(BASE() + '/', { redirect: 'manual' });
  const visitorPage = await visitorRes.text();
  const nonceCookie = /meow_visit=([^;]+)/.exec(visitorRes.headers.get('set-cookie') || '');
  check('a visitor we cannot see is handed a one-time nonce', !!nonceCookie,
    `set-cookie: ${visitorRes.headers.get('set-cookie')}`);
  const runtime = /<script id="meow-runtime"[^>]*>([\s\S]*?)<\/script>/.exec(visitorPage);
  let runtimeCfg = null;
  try { runtimeCfg = runtime && JSON.parse(runtime[1]); } catch (e) { runtimeCfg = null; }
  check('the page is told where to report from, and where to send it',
    !!runtimeCfg && runtimeCfg.report === true && runtimeCfg.post === '/api/visit/ip' &&
    Array.isArray(runtimeCfg.endpoints) && runtimeCfg.endpoints.length > 0,
    JSON.stringify(runtimeCfg));
  check('the services the page may call are allowed by the page\'s own policy',
    runtimeCfg && runtimeCfg.endpoints.every(u => /^https?:\/\//.test(u)),
    JSON.stringify(runtimeCfg && runtimeCfg.endpoints));

  /* store.json is written on a short timer, so a check has to wait for the row
     rather than read the file the instant the response arrives */
  const findVisit = async (predicate, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const rows = JSON.parse(fs.readFileSync(storePath, 'utf8')).visits;
      const hit = rows.slice(-8).find(predicate);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  const cookieHeader = nonceCookie ? { cookie: `meow_visit=${nonceCookie[1]}` } : {};
  const report = async (ip, extraHeaders) => {
    const res = await fetch(BASE() + '/api/visit/ip', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cookieHeader, extraHeaders || {}),
      body: JSON.stringify({ ip, source: 'browser' }),
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, body };
  };

  const bad = await report('10.0.0.7');
  check('a report of another private address is refused', bad.status === 400, JSON.stringify(bad));
  const junk = await report('someone-elses-address');
  check('a report of nonsense is refused', junk.status === 400, JSON.stringify(junk));

  const good = await report('8.8.4.4');
  check('the visitor’s own public address is accepted', good.status === 200 && good.body.ok === true, JSON.stringify(good));

  const reported = await findVisit(v => v.source === 'reported');
  check('the visit now shows the address the visitor reported',
    !!reported && reported.ip === '8.8.4.4' && reported.private === false && reported.reportState === 'accepted',
    JSON.stringify(reported));
  check('what we actually saw is kept beside it, not thrown away',
    !!reported && reported.socketIp === '127.0.0.1', JSON.stringify(reported && reported.socketIp));
  check('the row says where the address came from', !!reported && !!clientip.SOURCE_LABEL[reported.source],
    JSON.stringify(reported && reported.source));

  const secondReport = await report('9.9.9.9');
  check('the same nonce cannot report twice',
    secondReport.status === 404 && /expired/.test(String(secondReport.body.error)), JSON.stringify(secondReport));

  const strangerRes = await fetch(BASE() + '/api/visit/ip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ip: '8.8.4.4' }),
  });
  check('a report from nobody is refused', strangerRes.status === 400, String(strangerRes.status));

  /* With the switch off, the page is not told to ask and the endpoint refuses. */
  await post('/api/admin/settings', { reportVisitorIp: false });
  const offPage = await fetch(BASE() + '/', { redirect: 'manual' });
  const offHtml = await offPage.text();
  const offCfg = JSON.parse(/<script id="meow-runtime"[^>]*>([\s\S]*?)<\/script>/.exec(offHtml)[1]);
  check('with the switch off the page never asks a third party',
    offCfg.report === false && offCfg.endpoints.length === 0, JSON.stringify(offCfg));
  check('and no nonce is handed out', !/meow_visit=/.test(offPage.headers.get('set-cookie') || ''),
    String(offPage.headers.get('set-cookie')));
  const offReport = await report('8.8.4.4');
  check('and the endpoint refuses a late report', offReport.status === 400 || offReport.status === 403 || offReport.status === 404,
    JSON.stringify(offReport));
  await post('/api/admin/settings', { reportVisitorIp: true });

  /* Who may speak for the visitor is a setting the operator owns. */
  const autoOverview = await get('/api/admin/overview', { headers: { cookie: cookies } });
  check('the panel can see who is allowed to speak for the visitor',
    autoOverview.body.settings.trustProxy === 'auto' && autoOverview.body.settings.reportVisitorIp === true &&
    autoOverview.body.server.trustProxy === 'auto',
    JSON.stringify({ settings: autoOverview.body.settings.trustProxy, server: autoOverview.body.server.trustProxy }));
  const forwardedRow = await fetch(BASE() + '/', { headers: { 'x-forwarded-for': '1.1.1.1' }, redirect: 'manual' });
  check('a proxy in front of the app gets the visitor logged correctly',
    forwardedRow.status === 200);
  const loggedProxy = await findVisit(v => v.ip === '1.1.1.1');
  check('the visitor behind the proxy is logged by their own address',
    !!loggedProxy && loggedProxy.source === 'x-forwarded-for' && loggedProxy.private === false,
    JSON.stringify(loggedProxy));

  await post('/api/admin/settings', { trustProxy: '0' });
  const offOverview = await get('/api/admin/overview', { headers: { cookie: cookies } });
  check('the operator can switch proxy trust off',
    offOverview.body.settings.trustProxy === false && offOverview.body.server.trustProxy === false,
    JSON.stringify(offOverview.body.settings.trustProxy));
  check('and the choice is written where a restart will find it',
    JSON.parse(fs.readFileSync(path.join(ETC, 'config.json'), 'utf8')).trustProxy === false,
    fs.readFileSync(path.join(ETC, 'config.json'), 'utf8').slice(0, 200));
  const ignoredAt = Date.now();
  await fetch(BASE() + '/', { headers: { 'x-forwarded-for': '1.1.1.1' }, redirect: 'manual' });
  const ignored = await findVisit(v => v.t >= ignoredAt);
  check('with proxy trust off a forged header is ignored again',
    ignored.ip === '127.0.0.1' && ignored.source === 'socket', JSON.stringify(ignored));
  await post('/api/admin/settings', { trustProxy: 'auto' });
  check('proxy trust can be put back to automatic',
    (await get('/api/admin/overview', { headers: { cookie: cookies } })).body.settings.trustProxy === 'auto');

  /* ---- 16. restart from the panel --------------------------------------- */
  const beforeRestart = await waitForHealth(5000);
  const rres = await post('/api/admin/restart', {});
  check('restart is accepted from the panel', rres.status === 200 && rres.body.ok === true, JSON.stringify(rres.body));
  const afterRestart = await waitForFreshHealth(beforeRestart && beforeRestart.instanceId, 30000);
  check('the service restarted on demand', !!afterRestart,
    `instance before ${beforeRestart && beforeRestart.instanceId}, after ${afterRestart && afterRestart.instanceId}`);
  check('the store survived the restart (admin still registered)',
    JSON.parse(fs.readFileSync(storePath, 'utf8')).admin.username === 'michael');

  /* ---- 17. everything is still there after all of that ------------------ */
  const finalStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('visit history survived updates and restarts', finalStore.visits.length >= 4, String(finalStore.visits.length));
  check('credentials survived every restart', !!finalStore.admin && finalStore.admin.hash && finalStore.admin.username === 'michael');
  check('version history survived every restart', finalStore.versions.length >= 3, String(finalStore.versions.length));

  /* ---- 18. rate limiting (last: it deliberately fills this IP's bucket) -- */
  let limited = false;
  for (let i = 0; i < 300 && !limited; i++) {
    const r = await fetch(BASE() + '/api/admin/overview', { headers: { cookie: cookies } });
    if (r.status === 429) limited = true;
  }
  check('the admin API is rate limited per IP', limited);

  /* ------------------------------------------------------------------ done */
  await stopServer();
  /* A self-restarted service is a detached process, so the harness cannot wait
     on it — sweep anything still pointing at this throwaway directory. */
  spawnSync('bash', ['-c', `pkill -f ${JSON.stringify(TMP)} 2>/dev/null || true`]);
  gh.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  failures:');
    for (const f of failures) console.log('   - ' + f);
    console.log('\n  server output (tail):\n' + serverOutput.join('').split('\n').slice(-25).join('\n'));
  }
  console.log(`\n  working directory kept for inspection: ${TMP}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('\ntest crashed:', e && e.stack);
  console.log('\nserver output:\n' + serverOutput.join(''));
  await stopServer();
  process.exit(1);
});
