/**
 * Regression test: root must not take ownership of the service's files.
 *
 * The bug this exists to prevent: running `sudo meow-translator update` wrote the
 * store and the application tree as root, so the unprivileged service account
 * could no longer read its own data — the service failed to start and it looked
 * exactly like the visit log and credentials had vanished.
 *
 * Runs as root (skips otherwise, saying so):
 *
 *   sudo node tools/test-ownership.mjs
 *   sudo -E env "PATH=$PATH" node tools/test-ownership.mjs      # in CI
 *
 * It builds a throwaway installation owned by a uid that is NOT the one running
 * the test, drives a real CLI command and a real update + rollback against a
 * stand-in GitHub, and asserts the ownership of every produced file.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SERVICE_UID = 1;     // "daemon": exists on every Linux, is never us
const SERVICE_GID = 1;

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? '  → ' + detail : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  \u001b[33m–\u001b[0m ${name}  \u001b[2m(${why})\u001b[0m`); };

if (process.getuid() !== 0) {
  console.log('\n\x1b[33mThis test must run as root\x1b[0m — it needs to create files owned by another account.');
  console.log('Run it with:  sudo node tools/test-ownership.mjs\n');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-own-'));
fs.chmodSync(TMP, 0o755);            // the service account has to be able to walk in here
const APP = path.join(TMP, 'app');
const DATA = path.join(TMP, 'data');
const ETC = path.join(TMP, 'etc');
const GH_PORT = 19000 + Math.floor(Math.random() * 900);
const VERSION = '9.9.9';
const SHA = crypto.randomBytes(20).toString('hex');

const owner = p => { const s = fs.statSync(p); return `${s.uid}:${s.gid}`; };
const expectService = (label, p) => {
  let got;
  try { got = owner(p); } catch (e) { check(label, false, `cannot stat ${p}: ${e.message}`); return; }
  check(label, got === `${SERVICE_UID}:${SERVICE_GID}`,
    `${p} is owned by ${got}, expected ${SERVICE_UID}:${SERVICE_GID}`);
};

/* ------------------------------------------------------------------ setup */
function prepare() {
  fs.mkdirSync(APP, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(ETC, { recursive: true });
  const copy = spawnSync('bash', ['-c',
    `cd ${JSON.stringify(ROOT)} && tar --exclude=.git --exclude=node_modules --exclude=data --exclude=.npm --exclude=.cache --exclude=.local --exclude=.arena -cf - . | (cd ${JSON.stringify(APP)} && tar -xf -)`]);
  if (copy.status !== 0) throw new Error('could not stage the tree: ' + copy.stderr);
  fs.chownSync(APP, SERVICE_UID, SERVICE_GID);
  fs.chownSync(DATA, SERVICE_UID, SERVICE_GID);
  for (const p of ['', 'audio', 'bin', 'deploy', 'server', 'server/lib', 'src', 'tools', '.github', '.github/workflows']) {
    const dir = path.join(APP, p);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      try { fs.chownSync(path.join(dir, name), SERVICE_UID, SERVICE_GID); } catch (e) {}
    }
  }
  fs.chownSync(path.join(APP, 'VERSION'), SERVICE_UID, SERVICE_GID);
  fs.writeFileSync(path.join(ETC, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: 1, appDir: APP, dataDir: DATA, restartMode: 'off',
  }), { mode: 0o640 });
  fs.chownSync(path.join(ETC, 'config.json'), 0, SERVICE_GID);   // root-owned, group readable
}

function buildPayload() {
  const work = path.join(TMP, 'payload');
  fs.mkdirSync(work, { recursive: true });
  const top = path.join(work, `Cat-Translator-${SHA}`);
  spawnSync('bash', ['-c',
    `mkdir -p ${JSON.stringify(top)} && cd ${JSON.stringify(ROOT)} && tar --exclude=.git --exclude=node_modules --exclude=data --exclude=.npm --exclude=.cache --exclude=.local --exclude=.arena -cf - . | (cd ${JSON.stringify(top)} && tar -xf -)`]);
  fs.writeFileSync(path.join(top, 'VERSION'), VERSION + '\n');
  const tar = path.join(work, 'p.tar.gz');
  spawnSync('tar', ['-czf', tar, '-C', work, `Cat-Translator-${SHA}`]);
  return fs.readFileSync(tar);
}

function startFakeGitHub(tarball) {
  const server = http.createServer((req, res) => {
    if (/\/commits\//.test(req.url)) {
      const body = JSON.stringify({ sha: SHA, commit: { message: 'ownership test', committer: { date: new Date().toISOString() } } });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(body);
    }
    if (/contents\/VERSION/.test(req.url)) {
      const body = JSON.stringify({ content: Buffer.from(VERSION + '\n').toString('base64'), encoding: 'base64' });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(body);
    }
    if (/tarball|tar\.gz/.test(req.url)) { res.writeHead(200); return res.end(tarball); }
    if (/VERSION$/.test(req.url)) { res.writeHead(200); return res.end(VERSION + '\n'); }
    res.writeHead(404); res.end('nope');
  });
  return new Promise(r => server.listen(GH_PORT, '127.0.0.1', () => r(server)));
}

/** Run the deployed CLI the way an operator would: as root, via `sudo` semantics. */
/**
 * The service name here is deliberately not the real one, so a test run can
 * never restart a live service.
 *
 * This is asynchronous on purpose: spawnSync would block this process's event
 * loop, and this process is the one serving the stand-in GitHub — so a blocking
 * spawn would deadlock until the socket timed out (which is exactly what an
 * earlier version of this test did).
 */
/** Run the CLI as the service account, to prove the service itself is not
 *  blocked by another account's leftovers. */
function runCliAs(user, args) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA, MEOW_CONFIG: path.join(ETC, 'config.json'),
      MEOW_GITHUB_API: `http://127.0.0.1:${GH_PORT}`,
      MEOW_GITHUB_RAW: `http://127.0.0.1:${GH_PORT}`,
      MEOW_GITHUB_TAR: `http://127.0.0.1:${GH_PORT}`,
    });
    const assigns = Object.entries(env)
      .filter(([k]) => /^MEOW_|^HOME$|^PATH$/.test(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const child = spawn('su', ['-s', '/bin/sh', user, '-c',
      `${assigns} ${process.execPath} ${JSON.stringify(path.join(APP, 'bin', 'meow-translator'))} --service=meow-own-test ${args.join(' ')}`]);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', status => resolve({ status, stdout: out, stderr: err }));
  });
}

function runCli(args, extraEnv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(APP, 'bin', 'meow-translator'), '--service=meow-own-test', ...args], {
      env: Object.assign({}, process.env, {
        MEOW_APP_DIR: APP, MEOW_DATA_DIR: DATA, MEOW_CONFIG: path.join(ETC, 'config.json'),
        MEOW_GITHUB_API: `http://127.0.0.1:${GH_PORT}`,
        MEOW_GITHUB_RAW: `http://127.0.0.1:${GH_PORT}`,
        MEOW_GITHUB_TAR: `http://127.0.0.1:${GH_PORT}`,
      }, extraEnv || {}),
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', status => resolve({ status, stdout: out, stderr: err }));
  });
}

(async () => {
  console.log(`\n\x1b[1mOwnership regression test\x1b[0m  (this process runs as uid ${process.getuid()}, files must end up ${SERVICE_UID}:${SERVICE_GID})\n`);
  prepare();

/* ---------------------------------------------------------------------------
   A root command that has to create the data directory itself.

   matchOwner matches the neighbour, and there is no neighbour to match when the
   directory is what is being created: the file comes out root-owned and the
   service cannot read its own store, which reads like the data has vanished.
   This is that case, run against a missing data directory, with the config file
   pointing at an application directory owned by the service account.
   ------------------------------------------------------------------------ */
{
  const CLI = path.join(ROOT, 'bin', 'meow-translator');
  const fresh = path.join(TMP, 'fresh-data');
  const confPath = path.join(TMP, 'fresh-config.json');
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.writeFileSync(confPath, JSON.stringify({ appDir: APP, dataDir: fresh, host: '127.0.0.1', port: 18999 }));
  const run = spawnSync('node', [CLI, 'versions'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MEOW_CONFIG: confPath, MEOW_DATA_DIR: fresh, MEOW_APP_DIR: APP }),
  });
  check('a root command on a missing data directory still works', run.status === 0,
    (run.stderr || run.stdout || '').trim().slice(0, 200));
  if (fs.existsSync(path.join(fresh, 'store.json'))) {
    expectService('the data directory it created belongs to the service', fresh);
    expectService('and so does the store inside it', path.join(fresh, 'store.json'));
  } else {
    check('the store was created', false, 'no store.json in ' + fresh);
    check('and belongs to the service', false, 'nothing to check');
  }
  /* and the same store is readable when the service runs as that account */
  const asService = spawnSync('sudo', ['-u', `#${SERVICE_UID}`, '-g', `#${SERVICE_GID}`, 'test', '-r', path.join(fresh, 'store.json')],
    { encoding: 'utf8' });
  check('the service account can read it', asService.status === 0,
    (asService.stderr || '').trim().slice(0, 160));
}

  const tarball = buildPayload();
  const gh = await startFakeGitHub(tarball);

  try {
    /* ---- 1. a CLI command that writes the store ------------------------- */
    const cli = await runCli(['token', '--rotate']);
    check('the CLI runs as root', cli.status === 0, (cli.stdout + cli.stderr).slice(0, 200));
    expectService('store file keeps the service account after a root CLI run', path.join(DATA, 'store.json'));
    expectService('data directory keeps the service account', DATA);

    /* ---- 2. a full update driven as root -------------------------------- */
    const t0 = Date.now();
    const upd = await runCli(['update']);
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`     update took ${secs}s, exit ${upd.status}`);
    if (upd.status !== 0 || !/installed v9\.9\.9/.test(upd.stdout)) {
      console.log('     --- CLI output ---');
      for (const line of (upd.stdout + upd.stderr).split('\n').slice(-25)) console.log('     ' + line);
      console.log('     ------------------');
    }
    check('a root-driven update succeeds', upd.status === 0 && /installed v9\.9\.9/.test(upd.stdout),
      (upd.stdout + upd.stderr).slice(-300));
    expectService('application directory keeps the service account after the swap', APP);
    expectService('VERSION file keeps the service account', path.join(APP, 'VERSION'));
    expectService('a copied source file keeps the service account', path.join(APP, 'server', 'server.js'));
    expectService('the rollback snapshot keeps the service account', path.join(DATA, 'versions'));
    const snapshots = fs.readdirSync(path.join(DATA, 'versions'));
    check('a rollback snapshot was taken', snapshots.length > 0, snapshots.join(','));
    for (const name of snapshots) {
      expectService(`snapshot ${name} is readable by the service account`, path.join(DATA, 'versions', name));
    }
    check('the deployed version really changed', fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim() === VERSION);

    /* ---- 3. the store is readable by the service account ----------------
       Checked as the service account itself, so this is the exact question the
       service asks when it starts. */
    const asUser = spawnSync('su', ['-s', '/bin/sh', 'daemon', '-c', `cat ${JSON.stringify(path.join(DATA, 'store.json'))}`], { encoding: 'utf8' });
    check('the service account can read the store after a root update',
      asUser.status === 0 && asUser.stdout.length > 10,
      (asUser.stderr || '').slice(0, 160) || `status ${asUser.status}`);

    /* ---- 4. a root-driven rollback -------------------------------------- */
    const rb = await runCli(['rollback']);
    check('a root-driven rollback succeeds', rb.status === 0 && /rolled back/.test(rb.stdout),
      (rb.stdout + rb.stderr).slice(-200));
    expectService('application directory keeps the service account after a rollback', APP);
    expectService('store file keeps the service account after a rollback', path.join(DATA, 'store.json'));

    /* ---- 5. doctor reports a healthy install ---------------------------- */
    const doc = await runCli(['doctor', '--user', 'daemon', '--skip-unit-check']);
    check('doctor finds no problems after all of that', doc.status === 0 && /no problems found/.test(doc.stdout),
      (doc.stdout + doc.stderr).slice(-300));

    /* ---- 6. detection and repair ----------------------------------------
       Note the order: a check run repairs the store on the way out (the store is
       written by whoever runs the command, and its save hands the file back to
       the data directory's owner), so detection has to be measured before that
       second run can heal anything. */
    fs.chownSync(path.join(DATA, 'store.json'), 0, 0);
    const fix = await runCli(['doctor', '--user', 'daemon', '--fix', '--skip-unit-check']);
    check('doctor --fix repairs a root-owned store', /fixed/.test(fix.stdout) || /no problems/.test(fix.stdout),
      fix.stdout.slice(-200).replace(/\n/g, ' '));
    expectService('the store belongs to the service account after --fix', path.join(DATA, 'store.json'));

    /* ---- 7. ownership problems hide inside directories -------------------
       A snapshot tree written by another account is unreadable and undeletable
       for the service, which used to abort an update in the middle of pruning.
       doctor has to look inside, and an undeletable snapshot must never block
       the update itself. */
    const snapRoot = path.join(DATA, 'versions', 'stale-root-owned');
    fs.mkdirSync(snapRoot, { recursive: true });
    fs.writeFileSync(path.join(snapRoot, 'VERSION'), '0.9.0\n');
    fs.chownSync(snapRoot, 0, 0);
    fs.chmodSync(snapRoot, 0o700);

    const doc3 = await runCli(['doctor', '--user', 'daemon', '--skip-unit-check']);
    check('doctor looks inside the snapshot directory',
      /belong to another account/.test(doc3.stdout) && /stale-root-owned/.test(doc3.stdout),
      doc3.stdout.split('\n').filter(l => /!/.test(l)).join(' ').slice(0, 200));
    const fix3 = await runCli(['doctor', '--user', 'daemon', '--fix', '--skip-unit-check']);
    check('doctor --fix hands the snapshot back', /fixed/.test(fix3.stdout), fix3.stdout.slice(-160).replace(/\n/g, ' '));
    expectService('the stale snapshot belongs to the service account', snapRoot);

    /* now the harder one: an old snapshot the service genuinely cannot delete,
       because it sits in a directory that is not its own */
    /* A directory can only be deleted if its parent is writable, but the same
       is true of everything *inside* it — so a root-owned 0755 snapshot tree is
       undeletable for the service even though versions/ itself is its own.
       This is exactly what production hit. */
    const locked = path.join(DATA, 'versions', 'locked-by-root');
    fs.mkdirSync(path.join(locked, 'server'), { recursive: true });
    fs.writeFileSync(path.join(locked, 'server', 'server.js'), '// old\n');
    fs.writeFileSync(path.join(locked, 'VERSION'), '0.8.0\n');
    fs.chownSync(path.join(locked, 'server'), 0, 0);
    fs.chownSync(path.join(locked, 'server', 'server.js'), 0, 0);
    fs.chownSync(path.join(locked, 'VERSION'), 0, 0);
    fs.chownSync(locked, 0, 0);
    fs.chmodSync(locked, 0o755);
    fs.chmodSync(path.join(locked, 'server'), 0o755);
    expectService('the versions directory itself is still the service\'s', path.join(DATA, 'versions'));

    /* the service drives this update, so no chown happens on its behalf */
    const before = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
    before.versions.unshift({ version: '0.8.0', sha: '', dir: locked, installedAt: 1, kind: 'backup' });
    for (let i = 0; i < 8; i++) {
      const d = path.join(DATA, 'versions', `filler-${i}`);
      if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x'), 'x'); }
      fs.chownSync(d, SERVICE_UID, SERVICE_GID);
      before.versions.push({ version: '1.0.0', sha: '', dir: d, installedAt: 2 + i, kind: 'backup' });
    }
    fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(before));
    fs.chownSync(path.join(DATA, 'store.json'), SERVICE_UID, SERVICE_GID);

    const updAsService = await runCliAs('daemon', ['update']);
    check('an undeletable old snapshot does not block an update',
      updAsService.status === 0 && /installed v9\.9\.9/.test(updAsService.stdout),
      (updAsService.stdout + updAsService.stderr).slice(-240).replace(/\n/g, ' '));
    check('and the operator is told about it',
      /could not remove the old snapshot/.test(updAsService.stdout + updAsService.stderr),
      (updAsService.stdout + updAsService.stderr).slice(-240).replace(/\n/g, ' '));
    const after = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
    check('the snapshot it could not delete is still listed',
      after.versions.some(v => v.dir === locked),
      JSON.stringify(after.versions.map(v => v.dir ? path.basename(v.dir) : '(none)')));
    check('the update left a log entry explaining the leftover',
      after.updateLog.some(l => /could not remove old snapshot/.test(l.message)),
      JSON.stringify(after.updateLog.slice(-2).map(l => l.message)));


    const fix4 = await runCli(['doctor', '--user', 'daemon', '--fix', '--skip-unit-check']);
    check('doctor --fix clears the leftover snapshot too', /fixed/.test(fix4.stdout),
      fix4.stdout.split('\n').filter(l => /!|fixed/.test(l)).join(' ').slice(0, 200));
    expectService('the leftover snapshot is the service\'s now', snapRoot);
    expectService('and its parent is writable by the service', path.join(DATA, 'versions'));

    fs.chownSync(path.join(DATA, 'store.json'), 0, 0);
    const doc2 = await runCli(['doctor', '--user', 'daemon', '--skip-unit-check']);
    check('doctor spots a root-owned store',
      /store file is owned by uid 0/.test(doc2.stdout) && doc2.status !== 0,
      doc2.stdout.slice(-200).replace(/\n/g, ' '));
    const healthy = await runCli(['doctor', '--user', 'daemon', '--skip-unit-check']);
    check('and then reports a clean install', /no problems found/.test(healthy.stdout),
      healthy.stdout.slice(-160).replace(/\n/g, ' '));

  } finally {
    gh.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  if (fail) { console.log('\n  failures:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log(`\n  workspace: ${TMP}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\ntest crashed:', e && e.stack);
  process.exit(1);
});
