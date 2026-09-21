#!/usr/bin/env node
'use strict';
/**
 * Smoke test for a tree. Runs in two places:
 *   - during an update, against the STAGED copy before anything is installed
 *   - by the installer, against what it just deployed
 * It must never bind a port or touch the live data directory, so it is safe to
 * run anywhere. Exit code 0 = the tree looks loadable.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(process.env.MEOW_APP_DIR || path.join(__dirname, '..'));
const problems = [];
const notes = [];

function check(cond, message) {
  if (!cond) problems.push(message);
  return !!cond;
}

function syntaxOk(file) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });   // compile only, never runs
    return true;
  } catch (e) {
    problems.push(`${path.relative(ROOT, file)}: ${e.message}`);
    return false;
  }
}

/* 1. version ---------------------------------------------------------------- */
const versionFile = path.join(ROOT, 'VERSION');
let version = '';
try { version = fs.readFileSync(versionFile, 'utf8').trim(); } catch (e) {}
check(version !== '', 'VERSION file is missing or empty');
check(/^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(version), `VERSION "${version}" is not semver`);

/* 2. server modules compile ------------------------------------------------- */
const serverDir = path.join(ROOT, 'server');
const libDir = path.join(serverDir, 'lib');
check(fs.existsSync(path.join(serverDir, 'server.js')), 'server/server.js is missing');
check(fs.existsSync(path.join(serverDir, 'admin.html')), 'server/admin.html is missing');
let moduleCount = 0;
for (const dir of [serverDir, libDir]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    moduleCount++;
    syntaxOk(path.join(dir, name));
  }
}
notes.push(`${moduleCount} server modules compile`);

/* 3. the single-file app ---------------------------------------------------- */
const appFile = path.join(ROOT, 'cat-translator.html');
if (check(fs.existsSync(appFile), 'cat-translator.html is missing')) {
  const html = fs.readFileSync(appFile, 'utf8');
  const size = Buffer.byteLength(html);
  check(size > 100 * 1024, `cat-translator.html looks too small (${size} bytes)`);
  for (const marker of ['MEOW_APP', 'MEOW_SYNTH', 'MEOW_MATCH', 'MEOW_ENGINE']) {
    check(html.includes(marker), `cat-translator.html is missing the ${marker} module`);
  }
  /* the app must stay self-contained: no external fetches, no CDN */
  const external = (html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || []);
  check(external.length === 0, `cat-translator.html pulls ${external.length} external resource(s): ${external.slice(0, 2).join(', ')}`);
  notes.push(`app ${(size / 1024).toFixed(0)} kB, self-contained`);
}

/* 4. the admin page renders its shell --------------------------------------- */
const adminFile = path.join(serverDir, 'admin.html');
if (fs.existsSync(adminFile)) {
  const html = fs.readFileSync(adminFile, 'utf8');
  for (const marker of ['id="adminApp"', 'id="loginView"', 'id="panelView"']) {
    check(html.includes(marker), `admin.html is missing ${marker}`);
  }
  check(!/src\s*=\s*["']https?:/i.test(html), 'admin.html pulls an external script');
  notes.push(`admin panel ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB`);
}

/* 5. core modules load, and a store works in a throwaway directory ---------- */
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-smoke-'));
  const { Store } = require(path.join(libDir, 'store.js'));
  const { hashPassword, verifyPassword } = require(path.join(libDir, 'auth.js'));
  const st = new Store(path.join(tmp, 'store.json'));
  check(!!st.data.setup.token, 'a fresh store did not mint a setup token');
  const rec = hashPassword('smoke-test-password1');
  check(verifyPassword('smoke-test-password1', rec), 'password hashing round trip failed');
  check(!verifyPassword('wrong-password', rec), 'password hashing accepted a wrong password');
  st.data.visits.push({ t: Date.now(), hash: 'x' });
  st.save();
  const st2 = new Store(path.join(tmp, 'store.json'));
  check(st2.data.visits.length === 1, 'the store did not survive a reload');
  fs.rmSync(tmp, { recursive: true, force: true });
  notes.push('store + auth round trip ok');
} catch (e) {
  problems.push(`core modules failed: ${e.message}`);
}

/* 6. updater helper sanity --------------------------------------------------- */
try {
  const { compareVersions } = require(path.join(libDir, 'updater.js'));
  check(compareVersions('1.2.0', '1.1.9') === 1, 'version comparison is wrong (1.2.0 vs 1.1.9)');
  check(compareVersions('1.0.0', '1.0.0') === 0, 'version comparison is wrong (equal)');
  check(compareVersions('1.0.0', '1.0.1') === -1, 'version comparison is wrong (1.0.0 vs 1.0.1)');
} catch (e) {
  problems.push(`updater helpers failed: ${e.message}`);
}

if (problems.length) {
  console.error('selftest FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`selftest ok: v${version}, ${notes.join(', ')}`);
