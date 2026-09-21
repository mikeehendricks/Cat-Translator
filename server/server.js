#!/usr/bin/env node
'use strict';
/**
 * Meow translator server.
 *
 * Zero npm dependencies: everything below is Node's standard library, so the
 * installer never has to reach npm and an update can never break on a missing
 * package. What it serves:
 *
 *   /            the single-file translator app (cat-translator.html)
 *   /audio/*.wav  sample meows rendered by the synthesiser
 *   /admin       the admin panel (one-time registration, then login). The panel
 *                shares design/ui.css and design/symbols.html with the app, so
 *                it is composed with those files inlined when it is first asked
 *                for: a panel that needs a second request to look right would
 *                flash unstyled, and one that needs the network could not work
 *                on a machine with no way out.
 *   /api/*       the public version endpoint and the admin API
 *
 * Visit statistics record page views of the app only — admin traffic and static
 * assets are excluded, so the numbers mean "people using the translator".
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');

const config = require('./lib/config');
const { Store } = require('./lib/store');
const auth = require('./lib/auth');
const { Geo, normaliseIp, isPrivateIp } = require('./lib/geo');
const clientip = require('./lib/clientip');
const stats = require('./lib/stats');
const restart = require('./lib/restart');
const { Updater, sha8, dirSize } = require('./lib/updater');

const cfg = config.load();
const store = new Store(cfg.storePath);
const updater = new Updater(cfg, store);
const geo = new Geo(store, cfg, (level, msg) => { log(level, msg); });

const STARTED = Date.now();
/* Identifies THIS process. The admin panel and the test suite use it to tell a
   restarted service apart from the one that was about to exit. */
const INSTANCE = crypto.randomBytes(8).toString('hex');
updater.adoptInstalledTree();     // trust the VERSION file over the stored record

function log(level, msg) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line); else console.log(line);
}

/* ------------------------------------------------------------------ plumbing */

/**
 * The visitor's address, with its provenance. All of the judgement lives in
 * lib/clientip.js; this is the plumbing that hands it the request.
 */
function clientIp(req) {
  return clientip.resolve(req, cfg);
}

/* ---------------------------------------------------------------------------
   The admin page is written with two placeholders and composed on demand. The
   files are small and read once, so this costs nothing per request, and a
   missing file is reported loudly instead of shipping a broken panel.
   ------------------------------------------------------------------------ */
const DESIGN_DIR = path.join(__dirname, '..', 'design');
const composed = new Map();

/**
 * The served copy of the app page.
 *
 * Identical to cat-translator.html except for one script element the server
 * fills in: what the browser should do about the visitor's address. Composing it
 * here rather than shipping it in the file is what keeps the file self-contained
 * — opened from disk, there is no such element and the page does nothing about
 * addresses, which is the only sensible behaviour when nobody is listening.
 */
let appPageCache = null;
function appPage() {
  if (appPageCache) return appPageCache;
  const shell = fs.readFileSync(cfg.appHtml, 'utf8');
  const runtime = `<script id="meow-runtime" type="application/json">${visitorReportConfig()}</script>`;
  appPageCache = shell.includes('<!--__MEOW_RUNTIME__-->')
    ? shell.replace('<!--__MEOW_RUNTIME__-->', runtime)
    : shell;
  return appPageCache;
}

function inlineDesign(name) {
  if (composed.has(name)) return composed.get(name);
  const shell = fs.readFileSync(name, 'utf8');
  const read = (file, label) => {
    const full = path.join(DESIGN_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`${label} is missing: ${full}`);
    return fs.readFileSync(full, 'utf8');
  };
  const html = shell
    .replace('/*__MEOW_DESIGN__*/', () => read('ui.css', 'the design system'))
    .replace('<!--__MEOW_SYMBOLS__-->', () => read('symbols.html', 'the symbol sprite'));
  composed.set(name, html);
  return html;
}

/** One cookie's value, or ''. */
function cookieValue(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/** Read a small JSON body, refusing anything larger than `limit`. */
function readJson(req, res, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers) {
  const h = Object.assign({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }, headers || {});
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (!h['content-type']) h['content-type'] = 'text/plain; charset=utf-8';
    h['content-length'] = Buffer.byteLength(body);
  }
  res.writeHead(status, h);
  if (body === null || body === undefined) res.end();
  else res.end(body);
}

function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/* very small in-memory rate limiter, per IP, for the API routes */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n += 1;
  return b.n <= limit;
}

function serveFile(res, file, type, extraHeaders) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found\n');
    send(res, 200, buf, Object.assign({
      'content-type': type,
      'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300',
    }, extraHeaders || {}));
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16121f"/><path d="M14 44V26l7 7c6-5 16-5 22 0l7-7v18c0 4-3 6-7 6H21c-4 0-7-2-7-6z" fill="#f0a04b"/><circle cx="25" cy="35" r="3" fill="#16121f"/><circle cx="39" cy="35" r="3" fill="#16121f"/><circle cx="32" cy="42" r="2.5" fill="#16121f"/></svg>`;

/* --------------------------------------------------------------- admin state */

function currentSession(req) {
  return auth.sessionFromRequest(store, req);
}

function requireSession(req, res) {
  const sess = currentSession(req);
  if (!sess) { json(res, 401, { error: 'not signed in' }); return null; }
  if (req.method !== 'GET' && !auth.csrfOk(req, sess)) {
    json(res, 403, { error: 'missing or bad CSRF token — reload the admin page' });
    return null;
  }
  /* same-origin gate: an admin change must come from the admin page itself */
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    const host = req.headers.host;
    let ok = false;
    try { ok = new URL(origin).host === host; } catch (e) { ok = false; }
    if (!ok) { json(res, 403, { error: 'cross-origin admin request refused' }); return null; }
  }
  return sess;
}

function sessionPayload(sess) {
  return {
    username: store.data.admin ? store.data.admin.username : null,
    csrf: sess.csrf,
    createdAt: sess.createdAt,
    expiresAt: sess.expiresAt,
    ip: sess.ip,
    started: STARTED,
  };
}

/* ------------------------------------------------------------- visit capture */

/**
 * Record a page view, and — when the address we can see is not a public one —
 * give the visitor's browser the chance to tell us the address it really has.
 *
 * The cookie is the binding: it carries a nonce that matches exactly one visit,
 * so a report cannot be aimed at somebody else's row, and it expires by itself.
 * Nothing about the visitor is stored in it (no address, no identifier), and the
 * report endpoint is the only thing that reads it.
 */
function trackVisit(req, res, ipInfo) {
  const entry = stats.record(store, {
    ip: ipInfo.ip,
    path: '/',
    ua: req.headers['user-agent'],
    ref: req.headers.referer || req.headers.referrer || '',
    proxied: ipInfo.proxied,
    source: ipInfo.source,
    chain: ipInfo.chain,
  });

  const resolved = { ip: ipInfo.ip, source: ipInfo.source, private: ipInfo.private };
  if (clientip.wantsReport(resolved, store.data.settings)) {
    const nonce = crypto.randomBytes(16).toString('base64url');
    entry.reportNonce = nonce;
    entry.reportState = 'asked';
    store.dirty();
    /* SameSite=Lax so it survives an ordinary navigation to the page, HttpOnly
       so no script can read it, and short-lived — it exists to tie one report to
       one visit and nothing else. */
    res.setHeader('set-cookie',
      `meow_visit=${nonce}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax`);
  }

  const cached = geo.cached(ipInfo.ip);
  if (cached) stats.attachGeo(store, entry, cached);
  else if (store.data.settings.geoLookup && !ipInfo.private) {
    /* A private address has no location to look up — asking a provider about
       192.168.1.5 would come back with the provider's guess about a network
       that is not on the internet. Wait for the visitor report instead. */
    geo.lookup(ipInfo.ip).then(g => { if (g) stats.attachGeo(store, entry, g); }).catch(() => {});
  }
}

/** Where the browser can ask what address the world sees it from. Editable in
    the panel: an installation that would rather not use a third party can point
    these at its own service, or turn the whole thing off. */
function publicIpEndpoints() {
  const fromSettings = store.data.settings.publicIpEndpoints;
  if (Array.isArray(fromSettings) && fromSettings.length) return fromSettings.slice(0, 6);
  return [
    'https://ipwho.is/',
    'https://api.ipify.org/?format=json',
    'https://ifconfig.co/json',
  ];
}

/**
 * The hosts the browser will call when it asks what address the world sees it
 * from. They have to be named in the page's Content-Security-Policy or the
 * request is refused before it leaves the browser — a failure that looks exactly
 * like "the report never arrived".
 */
function publicIpConnectSrc() {
  const hosts = new Set();
  for (const url of publicIpEndpoints()) {
    try { hosts.add(new URL(url).origin); } catch (e) { /* skip a bad entry */ }
  }
  return Array.from(hosts).join(' ');
}

/** The report the page needs, injected where the placeholders are. */
function visitorReportConfig() {
  const settings = store.data.settings;
  const enabled = settings.reportVisitorIp !== false && settings.storeRawIp !== false;
  return JSON.stringify({
    report: enabled,
    post: '/api/visit/ip',
    endpoints: enabled ? publicIpEndpoints() : [],
  });
}

/* ------------------------------------------------------------------- routing */

async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');
  const ipInfo = clientIp(req);

  if (cfg.logRequests) log('info', `${req.method} ${pathname} ${ipInfo.ip}`);

  try {
    /* ---------------------------------------------------------------- public */
    if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/api/health')) {
      return json(res, 200, {
        ok: true,
        version: store.data.app.version,
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        instanceId: INSTANCE,
        startedAt: STARTED,
      });
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      return send(res, 200, FAVICON, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    }

    if (req.method === 'GET' && pathname === '/api/version') {
      const check = store.data.updateCheck;
      return json(res, 200, {
        version: store.data.app.version,
        instanceId: INSTANCE,
        sha: store.data.app.sha,
        shortSha: sha8(store.data.app.sha),
        installedAt: store.data.app.installedAt,
        source: store.data.app.source,
        latest: check && check.remote ? { version: check.remote.version, shortSha: check.remote.shortSha, url: check.remote.url } : null,
        updateAvailable: !!(check && check.remote && check.updateAvailable && check.newer),
        checkedAt: check ? check.checkedAt : null,
        repo: store.data.settings.githubRepo,
      });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app')) {
      trackVisit(req, res, ipInfo);
      /* The page carries a placeholder for the visitor-report configuration, so
         the bundle itself keeps no knowledge of any outside service and still
         works when it is opened straight from disk. */
      let page = null;
      try { page = appPage(); } catch (err) {
        log('warn', 'could not compose the app page: ' + err.message);
      }
      if (page) {
        return send(res, 200, page, Object.assign({ 'content-type': TYPES['.html'] }, {
          'cache-control': 'no-cache',
          'content-security-policy': [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob: data:",
            /* the visitor report is a same-origin POST; the lookup itself is a
               cross-origin GET, which needs connect-src to allow those hosts */
            "connect-src 'self' " + (store.data.settings.reportVisitorIp === false ? '' : publicIpConnectSrc()),
            "form-action 'none'",
            "base-uri 'none'",
            cfg.strictFrames ? "frame-ancestors 'none'" : "frame-ancestors *",
          ].join('; '),
        }));
      }
      return serveFile(res, cfg.appHtml, TYPES['.html'], {
        'cache-control': 'no-cache',
        /* The app is a self-contained page: it needs inline script/style, blob:
           audio for playback/download, and no network at all. Framing is left
           open so it can sit behind a reverse proxy or a preview pane; set
           cfg.strictFrames to lock that down. */
        'content-security-policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob: data:",
          "connect-src 'self'",
          "form-action 'none'",
          "base-uri 'none'",
          cfg.strictFrames ? "frame-ancestors 'none'" : "frame-ancestors *",
        ].join('; '),
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/audio/')) {
      const rel = pathname.replace(/^\/+/, '');
      const full = path.join(cfg.appDir, rel);
      if (!full.startsWith(path.join(cfg.appDir, 'audio'))) return send(res, 403, 'forbidden\n');
      return serveFile(res, full, TYPES[path.extname(full)] || 'application/octet-stream', { 'cache-control': 'public, max-age=3600' });
    }

    /* -------------------------------------------------------- visitor report */
    /**
     * The visitor's browser says which public address it has. Only accepted when
     * it matches the visit that asked (the nonce cookie), only for a real public
     * address, and only once — after that the visit row shows a WAN address and
     * a location looked up from it.
     */
    if (req.method === 'POST' && pathname === '/api/visit/ip') {
      const nonce = cookieValue(req, 'meow_visit');
      if (!nonce) return json(res, 400, { error: 'no visit to report for — reload the page' });
      const visit = stats.byReportNonce(store, nonce);
      if (!visit) return json(res, 404, { error: 'that visit has expired; reload the page' });
      /* The switch can be flipped after a page was served, so it is checked
         again here rather than only where the page was composed. */
      if (store.data.settings.reportVisitorIp === false || store.data.settings.storeRawIp === false) {
        return json(res, 403, { error: 'visitor address reporting is switched off on this installation' });
      }
      readJson(req, res, 4096).then((body) => {
        const check = clientip.validateReported(body && body.ip);
        if (!check.ok) {
          visit.reportState = 'rejected';
          visit.reportNote = check.reason;
          store.dirty();
          return json(res, 400, { error: 'not a usable address: ' + check.reason });
        }
        if (!visit.socketIp) visit.socketIp = visit.ip;      // keep what we saw
        visit.ip = check.ip;
        visit.reportedIp = check.ip;
        visit.source = 'reported';
        visit.private = false;
        visit.reportState = 'accepted';
        stats.rehash(store, visit, check.ip);
        visit.reportedAt = Date.now();
        visit.reportNonce = null;                 // single use
        store.audit('visitor', 'ip-report', `${check.ip} for visit ${visit.t}`, '');
        store.dirty();
        /* now that there is something real to look up, resolve its location */
        if (store.data.settings.geoLookup) {
          geo.lookup(check.ip).then(g => { if (g) stats.attachGeo(store, visit, g); }).catch(() => {});
        }
        return json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { error: 'bad request body' }));
      return;
    }

    /* ----------------------------------------------------------------- admin */
    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      let panel;
      try {
        panel = inlineDesign(path.join(__dirname, 'admin.html'));
      } catch (err) {
        log('error', 'admin panel could not be composed: ' + err.message);
        return send(res, 500, 'admin panel unavailable: ' + err.message + '\n');
      }
      return send(res, 200, panel, Object.assign({ 'content-type': TYPES['.html'] }, {
        'content-security-policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "form-action 'none'",
          "base-uri 'none'",
          cfg.strictFrames ? "frame-ancestors 'none'" : "frame-ancestors *",
        ].join('; '),
      }, { 'cache-control': 'no-store' }));
    }
    if (req.method === 'GET' && pathname.startsWith('/admin/')) {
      return send(res, 302, null, { location: '/admin' });
    }

    if (pathname.startsWith('/api/admin/')) {
      if (!rateLimit(`api:${ipInfo.ip}`, 240, 60000)) return json(res, 429, { error: 'too many requests' });
      return await adminApi(req, res, pathname.slice('/api/admin/'.length), ipInfo);
    }

    return send(res, 404, 'not found\n', { 'content-type': 'text/plain; charset=utf-8' });
  } catch (e) {
    log('error', `${req.method} ${pathname}: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    if (!res.headersSent) json(res, 500, { error: String((e && e.message) || e) });
  }
}

/* ----------------------------------------------------------------- admin API */

async function adminApi(req, res, route, ipInfo) {
  const method = req.method;
  const registered = !!store.data.admin;

  /* -- one-time registration ------------------------------------------------ */
  if (method === 'POST' && route === 'register') {
    if (registered) return json(res, 409, { error: 'an admin account already exists — registration is closed' });
    if (!rateLimit(`reg:${ipInfo.ip}`, 8, 60000)) return json(res, 429, { error: 'too many attempts' });
    const body = await readJson(req);
    const token = String(body.setupToken || '').trim();
    if (!token) return json(res, 400, { error: 'the setup token is required' });
    const expected = store.data.setup.token || '';
    const a = Buffer.from(token), b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      store.audit('unknown', 'register-rejected', 'bad setup token', ipInfo.ip);
      return json(res, 403, { error: 'that setup token is not valid' });
    }
    const username = String(body.username || '').trim();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      return json(res, 400, { error: 'username must be 3-32 characters (letters, digits, . _ -)' });
    }
    const pwProblem = auth.passwordProblem(String(body.password || ''));
    if (pwProblem) return json(res, 400, { error: pwProblem });

    store.setAdmin(username, String(body.password), auth);       // setAdmin flushes
    store.audit(username, 'register', `account created from ${ipInfo.ip}`, ipInfo.ip);
    store.save();
    const sess = auth.createSession(store, { clientIp: ipInfo.ip, headers: req.headers }, cfg.sessionHours);
    log('info', `admin account "${username}" registered`);
    return json(res, 200, { ok: true, session: sessionPayload(sess) }, {
      'set-cookie': auth.cookieHeader(sess.id, { secure: isSecure(req), maxAgeSec: cfg.sessionHours * 3600 }),
    });
  }

  /* -- login ---------------------------------------------------------------- */
  if (method === 'POST' && route === 'login') {
    if (!registered) return json(res, 409, { error: 'no admin account yet — register first' });
    const locked = auth.lockedFor(store, ipInfo.ip);
    if (locked > 0) {
      return json(res, 429, { error: `too many failed attempts — try again in ${Math.ceil(locked / 60000)} min` });
    }
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const admin = store.data.admin;
    const okUser = username.toLowerCase() === String(admin.username).toLowerCase();
    const okPass = auth.verifyPassword(password, admin);
    if (!okUser || !okPass) {
      auth.noteFailure(store, ipInfo.ip);
      store.audit(username || 'unknown', 'login-failed', ipInfo.ip, ipInfo.ip);
      return json(res, 401, { error: 'wrong username or password' });
    }
    auth.clearFailures(store, ipInfo.ip);
    const sess = auth.createSession(store, { clientIp: ipInfo.ip, headers: req.headers }, cfg.sessionHours);
    store.audit(username, 'login', '', ipInfo.ip);
    return json(res, 200, { ok: true, session: sessionPayload(sess) }, {
      'set-cookie': auth.cookieHeader(sess.id, { secure: isSecure(req), maxAgeSec: cfg.sessionHours * 3600 }),
    });
  }

  /* -- everything below needs a session ------------------------------------- */
  const sess = requireSession(req, res);
  if (!sess) return;

  if (method === 'GET' && route === 'session') {
    return json(res, 200, {
      session: sessionPayload(sess),
      admin: { username: store.data.admin.username, createdAt: store.data.admin.createdAt, updatedAt: store.data.admin.updatedAt },
      app: updater.installed(),
      restart: restart.describe(cfg),
    });
  }

  if (method === 'POST' && route === 'logout') {
    auth.dropSession(store, sess.id);
    store.audit(store.data.admin.username, 'logout', '', ipInfo.ip);
    return json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', { clear: true }) });
  }

  if (method === 'POST' && route === 'logout-all') {
    const n = store.data.sessions.length;
    store.data.sessions = [];
    store.audit(store.data.admin.username, 'logout-all', `${n} session(s) dropped`, ipInfo.ip);
    store.save();
    return json(res, 200, { ok: true, dropped: n }, { 'set-cookie': auth.cookieHeader('', { clear: true }) });
  }

  /* -- overview ------------------------------------------------------------- */
  if (method === 'GET' && route === 'overview') {
    const summary = stats.summarize(store, { days: 30 });
    const mem = process.memoryUsage();
    let storeSize = 0;
    try { storeSize = fs.statSync(cfg.storePath).size; } catch (e) {}
    return json(res, 200, {
      app: updater.installed(),
      latest: store.data.updateCheck ? store.data.updateCheck.remote : null,
      updateAvailable: !!(store.data.updateCheck && store.data.updateCheck.remote && store.data.updateCheck.updateAvailable && store.data.updateCheck.newer),
      lastCheck: store.data.updateCheck ? store.data.updateCheck.checkedAt : null,
      restart: restart.describe(cfg),
      server: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        starts: store.data.counters.starts,
        startedAt: STARTED,
        loadavg: process.loadavg ? process.loadavg().map(n => Math.round(n * 100) / 100) : [],
        rssBytes: mem.rss,
        heapUsed: mem.heapUsed,
        storeBytes: storeSize,
        dataDir: cfg.dataDir,
        appDir: cfg.appDir,
        host: cfg.host,
        port: cfg.port,
        trustProxy: cfg.trustProxy,
        trustedProxies: cfg.trustedProxies || [],
        reportVisitorIp: store.data.settings.reportVisitorIp !== false,
        versionsDirBytes: (() => { try { return dirSize(cfg.versionsDir); } catch (e) { return 0; } })(),
      },
      stats: summary,
      settings: publicSettings(),
      sessions: store.data.sessions.map(s => ({ ip: s.ip, ua: s.ua, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === sess.id })),
    });
  }

  /* -- visits --------------------------------------------------------------- */
  if (method === 'GET' && (route === 'visits' || route === 'visits.csv')) {
    const q = url.parse(req.url, true).query;
    const opts = {
      day: q.day || undefined,
      country: q.country || undefined,
      ip: q.ip || undefined,
      q: q.q || undefined,
      limit: Math.min(1000, Number(q.limit) || 100),
      offset: Math.max(0, Number(q.offset) || 0),
      bots: q.bots === '1',
    };
    const result = stats.query(store, opts);
    if (route === 'visits.csv') {
      const body = stats.csv(result.rows);
      return send(res, 200, body, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="meow-visits-${stats.dayKey(Date.now())}.csv"`,
      });
    }
    return json(res, 200, {
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      rows: result.rows,
      summary: stats.summarize(store, { days: 30 }),
      privacyMode: !store.data.settings.storeRawIp,
    });
  }

  if (method === 'POST' && route === 'visits/clear') {
    const body = await readJson(req);
    if (body.confirm !== 'clear-visits') return json(res, 400, { error: 'confirmation missing' });
    const n = store.data.visits.length;
    store.data.visits = [];
    store.data.dayStats = {};
    store.audit(store.data.admin.username, 'visits-cleared', `${n} rows`, ipInfo.ip);
    store.save();
    return json(res, 200, { ok: true, cleared: n });
  }

  /* -- credentials ---------------------------------------------------------- */
  if (method === 'POST' && route === 'credentials') {
    const body = await readJson(req);
    if (!auth.verifyPassword(String(body.currentPassword || ''), store.data.admin)) {
      store.audit(store.data.admin.username, 'credentials-rejected', 'wrong current password', ipInfo.ip);
      return json(res, 403, { error: 'current password is wrong' });
    }
    const username = body.username !== undefined ? String(body.username).trim() : store.data.admin.username;
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      return json(res, 400, { error: 'username must be 3-32 characters (letters, digits, . _ -)' });
    }
    let changed = [];
    if (username !== store.data.admin.username) changed.push('username');
    if (body.newPassword) {
      const pwProblem = auth.passwordProblem(String(body.newPassword));
      if (pwProblem) return json(res, 400, { error: pwProblem });
      if (String(body.newPassword) === String(body.currentPassword)) {
        return json(res, 400, { error: 'the new password is the same as the current one' });
      }
      store.setAdmin(username, String(body.newPassword), auth);
      changed.push('password');
    } else if (username !== store.data.admin.username) {
      store.data.admin.username = username;
      store.data.admin.updatedAt = Date.now();
      store.dirty();
    }
    if (!changed.length) return json(res, 400, { error: 'nothing to change' });

    /* a credential change invalidates every other session */
    store.data.sessions = store.data.sessions.filter(s => s.id === sess.id);
    store.audit(username, 'credentials-changed', changed.join('+'), ipInfo.ip);
    store.save();
    return json(res, 200, { ok: true, changed, username });
  }

  /* -- updates -------------------------------------------------------------- */
  if (method === 'GET' && route === 'updates') {
    return json(res, 200, {
      app: updater.installed(),
      lastCheck: store.data.updateCheck,
      history: updater.history(),
      log: updater.logTail(80),
      settings: publicSettings(),
      restart: restart.describe(cfg),
      repo: store.data.settings.githubRepo,
      channel: store.data.settings.updateChannel,
    });
  }

  if (method === 'POST' && route === 'updates/check') {
    const result = await updater.check();
    store.data.updateCheck = result;
    store.dirty();
    if (result.error) store.log('warn', `update check: ${result.error}`);
    else if (result.remote) {
      store.log('info', `update check: running v${result.installed.version}${result.installed.sha ? ` (${result.installed.shortSha})` : ''}, remote v${result.remote.version} (${result.remote.shortSha})`);
    }
    return json(res, 200, result);
  }

  if (method === 'POST' && route === 'updates/install') {
    const body = await readJson(req).catch(() => ({}));
    let result;
    try {
      result = await updater.install({ sha: body.sha || null, version: body.version || null });
      if (result.warnings && result.warnings.length) {
        for (const w of result.warnings) store.log('warn', w);
      }
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    store.data.updateCheck = null;
    store.dirty();
    if (result.changed) {
      const delay = Number(body.restartDelayMs) || 1500;
      const ok = restart.schedule(cfg, store, delay, `installed v${result.version}`);
      result.restarting = ok;
      result.restartMode = restart.describe(cfg).mode;
      if (!ok) {
        result.note = restart.describe(cfg).mode === 'off'
          ? 'restarting is disabled in the configuration — restart the service to load the new code'
          : 'a restart was already scheduled';
      }
    }
    return json(res, 200, result);
  }

  if (method === 'POST' && route === 'updates/rollback') {
    const body = await readJson(req).catch(() => ({}));
    let result;
    try {
      result = await updater.rollback(body.version || body.sha || null);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    const ok = restart.schedule(cfg, store, Number(body.restartDelayMs) || 1500, `rolled back to v${result.version}`);
    result.restarting = ok;
    if (!ok) result.note = 'a restart was already scheduled — the service will come back on its own';
    return json(res, 200, result);
  }

  /* -- settings ------------------------------------------------------------- */
  if (method === 'POST' && route === 'settings') {
    const body = await readJson(req);
    const s = store.data.settings;
    const before = JSON.stringify(s);
    if (body.storeRawIp !== undefined) s.storeRawIp = !!body.storeRawIp;
    if (body.geoLookup !== undefined) s.geoLookup = !!body.geoLookup;
    if (body.reportVisitorIp !== undefined) s.reportVisitorIp = !!body.reportVisitorIp;
    if (body.trustProxy !== undefined) {
      const raw = String(body.trustProxy).toLowerCase();
      if (raw === 'auto') cfg.trustProxy = 'auto';
      else if (raw === '1' || raw === 'true') cfg.trustProxy = true;
      else cfg.trustProxy = false;
      persistTrustProxy(cfg.trustProxy);
    }
    appPageCache = null;              // the page carries this configuration
    if (body.publicIpEndpoints !== undefined) {
      const list = Array.isArray(body.publicIpEndpoints) ? body.publicIpEndpoints : [];
      s.publicIpEndpoints = list
        .map(u => String(u).trim())
        .filter(u => /^https?:\/\//i.test(u) && u.length < 300)
        .slice(0, 6);
    }
    if (body.autoCheckUpdates !== undefined) s.autoCheckUpdates = !!body.autoCheckUpdates;
    if (body.autoInstallUpdates !== undefined) s.autoInstallUpdates = !!body.autoInstallUpdates;
    if (body.retentionDays !== undefined) s.retentionDays = Math.max(1, Math.min(3650, Number(body.retentionDays) || 90));
    if (body.updateChannel !== undefined) s.updateChannel = String(body.updateChannel).trim().slice(0, 60) || 'main';
    if (body.githubRepo !== undefined) s.githubRepo = String(body.githubRepo).trim().slice(0, 120);
    if (body.publicBaseUrl !== undefined) s.publicBaseUrl = String(body.publicBaseUrl).trim().slice(0, 200);
    if (body.githubToken !== undefined && body.githubToken !== '***') s.githubToken = String(body.githubToken).trim().slice(0, 200);
    store.prune();
    if (before !== JSON.stringify(s)) {
      store.audit(store.data.admin.username, 'settings-changed', diffKeys(JSON.parse(before), s).join(','), ipInfo.ip);
    }
    store.save();
    return json(res, 200, { ok: true, settings: publicSettings() });
  }

  if (method === 'POST' && route === 'restart') {
    const ok = restart.schedule(cfg, store, 800, 'admin requested');
    store.audit(store.data.admin.username, 'restart', restart.describe(cfg).mode, ipInfo.ip);
    return json(res, 200, { ok, mode: restart.describe(cfg).mode });
  }

  if (method === 'GET' && route === 'audit') {
    return json(res, 200, { rows: store.data.audit.slice(-300).reverse() });
  }

  return json(res, 404, { error: 'unknown admin route' });
}

function isSecure(req) {
  const forwardProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protoTrusted = cfg.trustProxy === true ||
    (cfg.trustProxy === 'auto' && clientip.peerIsTrusted(normaliseIp(req.socket.remoteAddress || ''), cfg));
  if (protoTrusted && forwardProto === 'https') return true;
  return !!(req.socket.encrypted);
}

function publicSettings() {
  const s = store.data.settings;
  return {
    storeRawIp: s.storeRawIp,
    retentionDays: s.retentionDays,
    geoLookup: s.geoLookup,
    reportVisitorIp: s.reportVisitorIp !== false,
    publicIpEndpoints: s.publicIpEndpoints || [],
    trustProxy: cfg.trustProxy,
    autoCheckUpdates: s.autoCheckUpdates,
    autoInstallUpdates: s.autoInstallUpdates,
    updateChannel: s.updateChannel,
    githubRepo: s.githubRepo,
    githubToken: s.githubToken ? '***' : '',
    publicBaseUrl: s.publicBaseUrl,
  };
}

/**
 * Remember a trustProxy change in the config file, so it survives a restart —
 * the setting lives in the config, not the store, because it is about the
 * network the process is listening on.
 */
function persistTrustProxy(value) {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.configPath, 'utf8'));
    raw.trustProxy = value;
    fs.writeFileSync(cfg.configPath, JSON.stringify(raw, null, 2) + '\n', { mode: 0o640 });
    log('info', `trustProxy set to ${JSON.stringify(value)} in ${cfg.configPath}`);
  } catch (err) {
    log('warn', `could not write trustProxy to ${cfg.configPath}: ${err.message}`);
  }
}

function diffKeys(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

/* ------------------------------------------------------------- housekeeping */

function housekeeping() {
  store.prune();
  store.save();
}

async function autoUpdateCheck() {
  if (!store.data.settings.autoCheckUpdates) return;
  try {
    const result = await updater.check();
    store.data.updateCheck = result;
    store.dirty();
    if (result.error) { log('warn', `automatic update check: ${result.error}`); return; }
    if (result.updateAvailable && result.newer) {
      store.log('info', `update available: v${result.remote.version} (${result.remote.shortSha})`);
      if (store.data.settings.autoInstallUpdates) {
        const key = result.remote.sha;
        if (store.data.lastAutoAttempt !== key) {
          store.data.lastAutoAttempt = key;
          store.dirty();
          log('info', `auto-installing v${result.remote.version}`);
          const out = await updater.install({ auto: true, sha: key, version: result.remote.version });
          if (out.changed) restart.schedule(cfg, store, 1500, `auto-installed v${out.version}`);
        }
      }
    }
  } catch (e) {
    log('warn', `automatic update check failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------- startup */

async function main() {
  if (process.argv.includes('--print-version')) {
    console.log(store.data.app.version);
    process.exit(0);
  }
  if (process.argv.includes('--print-setup-token')) {
    console.log(store.data.setup.used ? '(registration already completed)' : store.data.setup.token);
    process.exit(0);
  }

  const supervised = process.env.MEOW_SUPERVISED === '1';
  if (supervised) {
    const free = await restart.waitForPort(cfg, 20000);
    if (!free) log('warn', 'the port did not free up in time — trying anyway');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch(e => {
      log('error', `unhandled: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log('error', `port ${cfg.port} is already in use — another copy of the service, or a web server, is holding it`);
      log('error', `  find it with: sudo ss -ltnp | grep :${cfg.port}   ·   or run on another port: sudo meow-translator config --port 8080`);
      process.exit(1);
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      log('error', `not allowed to bind port ${cfg.port} (ports below 1024 need CAP_NET_BIND_SERVICE)`);
      log('error', '  as a service: sudo meow-translator install-service   (the unit grants that capability)');
      log('error', `  as a developer: run it on a high port instead, e.g. MEOW_PORT=8787 node server/server.js`);
      process.exit(1);
    }
    log('error', `server error: ${err.message}`);
  });

  server.listen(cfg.port, cfg.host, () => {
    const v = store.data.app.version;
    log('info', `meow translator v${v} listening on http://${cfg.host}:${cfg.port}/`);
    log('info', `app dir ${cfg.appDir} · data dir ${cfg.dataDir}`);
    log('info', `restart mode: ${restart.describe(cfg).detail}`);
    if (!store.data.admin) log('info', `no admin yet — finish setup at /admin with the token from "meow-translator token"`);
  });

  /* keep the process from holding anything open it should not */
  housekeeping();
  const hk = setInterval(housekeeping, 5 * 60 * 1000);
  hk.unref();
  const ac = setInterval(autoUpdateCheck, 6 * 3600 * 1000);
  ac.unref();
  setTimeout(() => { if (store.data.settings.autoCheckUpdates) autoUpdateCheck(); }, 15000).unref();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('info', `${sig} — flushing store and shutting down`);
      try { store.save(); } catch (e) {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
  process.on('uncaughtException', e => log('error', `uncaught exception: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', e => log('error', `unhandled rejection: ${e && e.stack ? e.stack : e}`));
}

if (require.main === module) main();

module.exports = { handler, cfg, store, updater, geo };
