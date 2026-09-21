/**
 * Verify a running installation end-to-end, over HTTP, the way a user would.
 *
 *   node tools/test-installed.mjs http://127.0.0.1:8899 <setup-token>
 *
 * Checks: the app page and its version badge, the admin panel, one-time
 * registration, visit logging with a real geolocation lookup, and the
 * self-restart handshake (the service must come back on its own).
 * It leaves the admin account registered — run it against a fresh instance.
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8899').replace(/\/$/, '');
const TOKEN = process.argv[3] || '';
const SPOOF_IP = process.argv[4] || '8.8.8.8';

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? '  → ' + detail : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  \u001b[33m–\u001b[0m ${name}  ${why ? '\u001b[2m(' + why + ')\u001b[0m' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = '';
function keepCookie(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of sc) {
    if (/Max-Age=0/.test(c)) { cookie = ''; continue; }
    cookie = c.split(';')[0];
  }
}

async function call(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers, redirect: 'manual' }));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  keepCookie(res);
  return { status: res.status, body, headers: res.headers };
}
const adminPost = (path, body, csrf) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-meow-csrf': csrf || '' },
  body: JSON.stringify(body || {}),
});

(async () => {
  console.log(`\n\x1b[1mVerifying the installation at ${BASE}\x1b[0m\n`);
  let csrf = '';

  /* ---- the public app ---------------------------------------------------- */
  const page = await call('/');
  check('the translator app is served at /', page.status === 200 && /MEOW_APP/.test(page.body));
  check('the page shows the app version', /version \d+\.\d+\.\d+/.test(page.body),
    (String(page.body).match(/version [\d.]+/) || [''])[0]);
  check('the page is self-contained (no external resources)',
    !/(?:src|href)\s*=\s*["']https?:\/\//i.test(page.body));

  const ver = await call('/api/version');
  check('/api/version answers', ver.status === 200 && !!ver.body.version, JSON.stringify(ver.body).slice(0, 120));
  check('/api/version identifies the process', !!ver.body.instanceId);
  console.log(`     running v${ver.body.version}${ver.body.shortSha ? ' (' + ver.body.shortSha + ')' : ''}` +
    `${ver.body.latest ? `, latest on GitHub v${ver.body.latest.version}` : ''}`);

  /* ---- the admin panel --------------------------------------------------- */
  const admin = await call('/admin');
  check('the admin panel is served at /admin', admin.status === 200 && /id="loginView"/.test(admin.body));
  check('the panel carries a Content-Security-Policy', !!admin.headers.get('content-security-policy'));
  check('the admin panel is marked noindex', /noindex/.test(admin.body));

  const session = await call('/api/admin/session');
  if (session.status === 200) {
    console.log('     an admin account already exists here — registration checks are skipped');
    skip('registration requires the setup token', 'already registered');
    skip('registration with the installer token', 'already registered');
  } else {
    const pre = await adminPost('/api/admin/register', { username: 'admin', password: 'test-pass-1234', setupToken: 'wrong' });
    if (pre.status === 409) {
      console.log('     registration is closed on this instance');
      skip('registration requires the setup token', 'already registered');
      skip('registration with the installer token', 'already registered');
    } else {
      check('registration refuses a wrong setup token', pre.status === 403, JSON.stringify(pre.body).slice(0, 120));
      const reg = await adminPost('/api/admin/register', { username: 'admin', password: 'test-pass-1234', setupToken: TOKEN });
      check('registration succeeds with the token from the installer', reg.status === 200 && !!reg.body.session,
        JSON.stringify(reg.body).slice(0, 140));
      if (reg.status === 200) csrf = reg.body.session.csrf;
      const second = await adminPost('/api/admin/register', { username: 'other', password: 'test-pass-1234', setupToken: TOKEN });
      check('registration closes after the first account', second.status === 409);
    }
  }

  /* If an account already exists, log in with the credentials supplied through
     the environment (MEOW_USER / MEOW_PASS) rather than pretending to check. */
  let overview = await call('/api/admin/overview');
  if (overview.status === 401 && process.env.MEOW_USER && process.env.MEOW_PASS) {
    const login = await adminPost('/api/admin/login', { username: process.env.MEOW_USER, password: process.env.MEOW_PASS });
    if (login.status === 200) { csrf = login.body.session.csrf; overview = await call('/api/admin/overview'); }
    else console.log(`     login failed: ${JSON.stringify(login.body).slice(0, 120)}`);
  }
  check('the admin API answers with a session', overview.status === 200,
    `${overview.status}${overview.status === 401 ? ' — set MEOW_USER/MEOW_PASS, or run against a fresh instance' : ''}`);
  if (overview.status === 200) {
    check('the admin panel is told the app version', overview.body.app && /^\d+\.\d+\.\d+/.test(overview.body.app.version));
    check('server details are present', !!overview.body.server && !!overview.body.server.node);
    console.log(`     v${overview.body.app.version} · node ${overview.body.server.node} · restart mode ${overview.body.restart.mode}`);
    csrf = csrf || (await call('/api/admin/session')).body.session.csrf;
  }

  /* ---- visits and location ---------------------------------------------- */
  const trustProxy = !!(overview.body && overview.body.server && overview.body.server.trustProxy);
  await call('/', { headers: { 'x-forwarded-for': SPOOF_IP } });
  await call('/', { headers: { 'x-forwarded-for': SPOOF_IP } });
  console.log(`     waiting for the geolocation lookup of ${SPOOF_IP} …`);
  let located = null;
  for (let i = 0; i < 20 && !located; i++) {
    await sleep(700);
    const v = await call('/api/admin/visits?limit=20');
    if (v.status !== 200) break;
    const row = (v.body.rows || []).find(r => r.geo && r.geo.country && !r.geo.local);
    if (row) located = row;
  }
  if (!trustProxy && !located) {
    skip('a visit from a public address is located', 'trustProxy is off, so the socket address (localhost) is logged instead');
    console.log('     to test it: set "trustProxy": true in the config (any reverse proxy deployment) and retry');
  } else {
    check('a visit from a public address was recorded', !!located,
      'no row with a resolved location (is geolocation enabled and is outbound HTTPS allowed?)');
  }
  if (located) {
    console.log(`     ${located.ip} → ${[located.geo.city, located.geo.region, located.geo.country].filter(Boolean).join(', ')}` +
      `${located.geo.isp ? ' (' + located.geo.isp + ')' : ''}`);
    check('the location has a country', !!located.geo.country);
  }
  const visits = await call('/api/admin/visits?limit=100');
  if (visits.status === 200) {
    check('the visit log is reachable', visits.body.total > 0, String(visits.body.total));
    check('the daily statistics series is built', visits.body.summary.series.length === 30);
  } else {
    skip('the visit log is reachable', 'no admin session');
  }

  /* ---- self-restart (the path an update uses) --------------------------- */
  if (csrf) {
    const before = (await call('/api/health')).body;
    const r = await adminPost('/api/admin/restart', {}, csrf);
    check('a restart can be requested from the panel', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    let after = null;
    for (let i = 0; i < 60 && !after; i++) {
      await sleep(800);
      try {
        const h = await call('/api/health');
        if (h.status === 200 && h.body.instanceId && h.body.instanceId !== before.instanceId) after = h.body;
      } catch (e) { /* still down */ }
    }
    check('the service came back on its own with a new process', !!after,
      `instance ${before.instanceId} → ${after && after.instanceId}`);
    if (after) check('the restarted service runs the same version', after.version === before.version);
    check('the session and data survived the restart', (await call('/api/admin/overview')).status === 200);
  }

  console.log(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  if (fail) { console.log('\n  failures:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nverification crashed:', e && e.stack); process.exit(1); });
