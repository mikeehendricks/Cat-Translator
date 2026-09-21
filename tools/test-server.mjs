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
    host: '127.0.0.1', port: PORT, appDir: APP, dataDir: DATA, restartMode: 'exec', trustProxy: false, sessionHours: 12,
  }, null, 2));

  /* ---- 0b. the shipped selftest must pass on a clean tree ----------------- */
  const st = spawnSync(process.execPath, [path.join(APP, 'server', 'selftest.js')], { cwd: APP, encoding: 'utf8', env: Object.assign({}, process.env, { MEOW_APP_DIR: APP }) });
  check('selftest passes on the tree', st.status === 0, (st.stdout + st.stderr).trim().slice(0, 200));

  /* ---- 0c. install.sh syntax --------------------------------------------- */
  const bashCheck = spawnSync('bash', ['-n', path.join(APP, 'install.sh')], { encoding: 'utf8' });
  check('install.sh parses (bash -n)', bashCheck.status === 0, bashCheck.stderr.trim());
  const unCheck = spawnSync('bash', ['-n', path.join(APP, 'uninstall.sh')], { encoding: 'utf8' });
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

  /* ---- 15. restart from the panel --------------------------------------- */
  const beforeRestart = await waitForHealth(5000);
  const rres = await post('/api/admin/restart', {});
  check('restart is accepted from the panel', rres.status === 200 && rres.body.ok === true, JSON.stringify(rres.body));
  const afterRestart = await waitForFreshHealth(beforeRestart && beforeRestart.instanceId, 30000);
  check('the service restarted on demand', !!afterRestart,
    `instance before ${beforeRestart && beforeRestart.instanceId}, after ${afterRestart && afterRestart.instanceId}`);
  check('the store survived the restart (admin still registered)',
    JSON.parse(fs.readFileSync(storePath, 'utf8')).admin.username === 'michael');

  /* ---- 16. everything is still there after all of that ------------------ */
  const finalStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('visit history survived updates and restarts', finalStore.visits.length >= 4, String(finalStore.visits.length));
  check('credentials survived every restart', !!finalStore.admin && finalStore.admin.hash && finalStore.admin.username === 'michael');
  check('version history survived every restart', finalStore.versions.length >= 3, String(finalStore.versions.length));

  /* ---- 17. rate limiting (last: it deliberately fills this IP's bucket) -- */
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
