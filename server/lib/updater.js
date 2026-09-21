'use strict';
/**
 * Update system: check GitHub, install a pinned commit, roll back.
 *
 * Design notes (these are the parts that make it safe to let a web panel do
 * this):
 *   1. The unit of an update is a COMMIT SHA, not a branch tip. We resolve the
 *      branch once, pin the sha, and install exactly that — so what is tested is
 *      what gets written, even if someone pushes while we are working.
 *   2. Nothing is touched until the staged copy passes a smoke test run in a
 *      temporary directory (`node server/selftest.js`).
 *   3. The previous tree is copied into <dataDir>/versions/<version>-<sha8>/ and
 *      registered in the store BEFORE the swap, so a rollback is always
 *      available, including back to the very first install.
 *   4. Data and configuration live outside the install directory, so no update
 *      or rollback can touch the store, the credentials or the visit history.
 *   5. Integrity rests on TLS plus the pinned commit: the archive's top-level
 *      directory must carry that sha and the VERSION inside it must match what
 *      the API reported. There is no signature because the update source is a
 *      public repository we do not hold release keys for — if you fork this and
 *      host it privately, turn on the token setting and treat it as trusted
 *      code, because that is what it is.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const archiveUtil = require('./archive');
const { Readable } = require('node:stream');
const { chownTree, ownerOf, isRoot, serviceOwner, giveTo } = require('./fsowner');

const PROTECTED = new Set(['.git', 'node_modules', 'data', '.env', 'local']);

/* Endpoint bases. Overridable so the test suite (and anyone mirroring the
   repository) can point the updater somewhere else; GitHub Enterprise works the
   same way by setting MEOW_GITHUB_API. */
const GH_API = () => process.env.MEOW_GITHUB_API || 'https://api.github.com';
const GH_RAW = () => process.env.MEOW_GITHUB_RAW || 'https://raw.githubusercontent.com';
const GH_TAR = () => process.env.MEOW_GITHUB_TAR || 'https://codeload.github.com';
const MAX_ARCHIVE = 96 * 1024 * 1024;

/* ------------------------------------------------------------------ helpers */

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '', raw: String(v).trim() };
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;                 // 1.0.0 > 1.0.0-rc1
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function sha8(sha) { return String(sha || '').slice(0, 8); }

function ghHeaders(token) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'meow-translator-updater' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(url, token) {
  const res = await fetch(url, { headers: ghHeaders(token), redirect: 'follow' });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (!res.ok) {
    let msg = `GitHub responded ${res.status}`;
    if (res.status === 404) msg += ' (repository or branch not found, or it is private and no token is set)';
    if (res.status === 403 && remaining === '0') msg += ' (API rate limit reached — set a token in settings)';
    const body = await res.text().catch(() => '');
    if (body && res.status !== 404) msg += `: ${body.slice(0, 200)}`;
    throw new Error(msg);
  }
  return res.json();
}

/** Recursive copy that ignores the paths an update must never overwrite. */
function copyTree(src, dest, opts) {
  opts = opts || {};
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name), to = path.join(dest, name);
    let st;
    try { st = fs.lstatSync(from); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (PROTECTED.has(name) || (opts.skip && opts.skip.includes(name))) continue;
      copied.push(...copyTree(from, to, opts));
    } else if (st.isFile()) {
      fs.copyFileSync(from, to);
      try { fs.chmodSync(to, st.mode & 0o777); } catch (e) {}
      copied.push(path.relative(opts.root || src, to));
    }
  }
  return copied;
}

function removeExtras(src, dest) {
  /* after copying, delete files in dest that the new tree does not have — but
     never anything protected, so a stray data dir or the admin's own notes stay */
  let removed = 0;
  for (const name of fs.readdirSync(dest)) {
    if (PROTECTED.has(name)) continue;
    const from = path.join(src, name), to = path.join(dest, name);
    if (!fs.existsSync(from)) {
      fs.rmSync(to, { recursive: true, force: true });
      removed++;
      continue;
    }
    const st = fs.lstatSync(to);
    if (st.isDirectory()) removed += removeExtras(from, to);
  }
  return removed;
}

function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (st.isDirectory()) total += dirSize(p);
    else total += st.size;
  }
  return total;
}

/* --------------------------------------------------------------- the updater */

class Updater {
  constructor(cfg, store, log) {
    this.cfg = cfg;
    this.store = store;
    this.log = log || ((level, msg) => store.log(level, msg));
    this.running = null;                // an install in progress (deduplicated)
  }

  settings() {
    const s = this.store.data.settings;
    return {
      repo: (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, ''),
      branch: (s.updateChannel || 'main').trim(),
      token: (s.githubToken || '').trim(),
    };
  }

  /** Resolve the branch to a commit and read the VERSION at that commit. */
  async check() {
    const { repo, branch, token } = this.settings();
    const installed = this.installed();
    const out = {
      installed,
      remote: null,
      updateAvailable: false,
      newer: false,                     // remote is genuinely newer than installed
      sameSha: false,
      checkedAt: Date.now(),
      error: null,
      repo, branch,
    };
    if (!repo) { out.error = 'no GitHub repository configured'; return out; }
    try {
      const commit = await ghJson(`${GH_API()}/repos/${repo}/commits/${encodeURIComponent(branch)}`, token);
      const sha = commit.sha;
      const date = commit.commit && commit.commit.committer ? commit.commit.committer.date : null;
      let version = null;
      try {
        const file = await ghJson(`${GH_API()}/repos/${repo}/contents/VERSION?ref=${sha}`, token);
        version = Buffer.from(file.content || '', file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8').trim();
      } catch (e) {
        /* fall back to the raw endpoint (works for public repos without a token) */
        const raw = await fetch(`${GH_RAW()}/${repo}/${sha}/VERSION`, { redirect: 'follow' });
        if (!raw.ok) throw new Error(`VERSION not found on ${repo}@${branch}`);
        version = (await raw.text()).trim();
      }
      out.remote = {
        version,
        sha,
        shortSha: sha8(sha),
        date,
        message: commit.commit && commit.commit.message ? commit.commit.message.split('\n')[0].slice(0, 120) : '',
        url: `https://github.com/${repo}/commit/${sha}`,
      };
      out.sameSha = !!installed.sha && installed.sha === sha;
      out.updateAvailable = !out.sameSha && (!installed.sha || installed.version !== version || installed.sha !== sha);
      const cmp = compareVersions(version, installed.version);
      out.newer = cmp > 0;
      /* A republished identical version is still an update (different commit). */
      out.publish = cmp === 0 && !out.sameSha;
      out.rollbackAvailable = !!this.store.data.versions.find(v => v.sha && v.sha !== installed.sha);
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  installed() {
    const a = this.store.data.app || {};
    return {
      version: a.version || this.readVersionFile() || '0.0.0',
      sha: a.sha || '',
      shortSha: sha8(a.sha),
      installedAt: a.installedAt || 0,
      source: a.source || 'installer',
    };
  }

  readVersionFile() {
    try { return fs.readFileSync(this.cfg.versionFile, 'utf8').trim(); } catch (e) { return ''; }
  }

  history() {
    return this.store.data.versions.slice().reverse().map(v => ({
      version: v.version,
      sha: v.sha, shortSha: sha8(v.sha),
      installedAt: v.installedAt,
      kind: v.kind,
      backupDir: v.dir ? path.relative(this.cfg.dataDir, v.dir) : null,
      restorable: !!(v.dir && fs.existsSync(v.dir)),
      current: v.sha ? v.sha === this.store.data.app.sha : v.version === this.store.data.app.version,
      sizeBytes: v.dir && fs.existsSync(v.dir) ? dirSize(v.dir) : 0,
      /* "running" has to mean exactly one row. Matching on the version alone is
         not enough: several snapshots can carry the same version number (an
         install snapshot, a pre-update snapshot, a rollback target), and then the
         panel pointed at all of them at once. A snapshot is only what is
         deployed if it is the one that was restored, or its commit is the one
         running. A build that came from GitHub is not a snapshot at all. */
      current: !!(v.dir && v.dir === this.store.data.app.restoredFrom) ||
        !!(v.sha && this.store.data.app.sha && v.sha === this.store.data.app.sha),
    }));
  }

  /** Backup the live tree into the versions store. Returns the backup dir. */
  /** Create a directory (and its parents) owned like the data directory. */
  /**
   * Owner for anything created under the data directory: whoever owns it now,
   * or — when it is missing or root-owned, meaning we are about to be the ones
   * creating it — whoever the service runs as. Matching the neighbour cannot
   * work for the directory itself, and a root-owned data directory is a service
   * that will not start.
   */
  dataOwner() {
    const own = ownerOf(this.cfg.dataDir);
    if (own && own.uid !== 0) return own;
    return serviceOwner({ dataDir: this.cfg.dataDir, configPath: this.cfg.configPath }) || own;
  }

  ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
    if (isRoot()) {
      /* mkdir may have just created the data directory, versions/ or staging/
         as root, so fix those too — not only the leaf — and then the leaf
         itself and anything in it. */
      const owner = this.dataOwner();
      for (const d of [this.cfg.dataDir, this.cfg.versionsDir, this.cfg.stagingDir, p]) {
        if (fs.existsSync(d)) giveTo(d, owner);
      }
      chownTree(p, owner);
    }
    return p;
  }

  backup(label, kind) {
    const cur = this.installed();
    const dir = path.join(this.cfg.versionsDir, `${cur.version}-${sha8(cur.sha) || 'local'}-${Date.now()}`);
    this.ensureDir(dir);
    copyTree(this.cfg.appDir, dir, {});
    /* root may be the one taking this snapshot, and the service has to be able to
       read it back to roll back — so hand the whole thing to the data directory's
       owner, the directory itself included. */
    if (isRoot()) {
      const owner = this.dataOwner();
      giveTo(this.cfg.versionsDir, owner);
      chownTree(dir, owner);
    }
    this.store.data.versions.push({
      version: cur.version,
      sha: cur.sha,
      dir,
      installedAt: Date.now(),
      kind: kind || 'backup',
      label: label || '',
    });
    this.pruneBackups();
    this.store.dirty();
    this.log('info', `backed up v${cur.version}${cur.sha ? ` (${sha8(cur.sha)})` : ''} to ${path.basename(dir)}`);
    return dir;
  }

  /**
   * Drop the oldest snapshots beyond `keep`.
   *
   * A snapshot can be owned by another account — e.g. one taken by root before
   * an update, on a host where the data directory later belonged to the service
   * user. The service then cannot delete it, and that is not a reason to refuse
   * an update: keep the snapshot, say so, and let `doctor --fix` finish the job.
   */
  pruneBackups(keep) {
    if (!Array.isArray(this.warnings)) this.warnings = [];
    const versions = this.store.data.versions;
    keep = keep || 6;
    while (versions.length > keep) {
      const old = versions[0];
      if (!old || !old.dir) { versions.shift(); continue; }
      try {
        fs.rmSync(old.dir, { recursive: true, force: true });
      } catch (e) {
        const who = (() => { try { const st = fs.statSync(old.dir); return `uid ${st.uid}`; } catch (_) { return 'another account'; } })();
        const hint = (e.code === 'EACCES' || e.code === 'EPERM')
          ? ` — ${path.basename(old.dir)} is owned by ${who}. Leave it alone? Run: sudo meow-translator doctor --fix`
          : ` (${e.code || e.message})`;
        this.warnings = this.warnings || [];
        this.warnings.push(`could not remove the old snapshot ${path.basename(old.dir)}${hint}`);
        this.log('warn', `could not remove old snapshot ${path.basename(old.dir)}: ${e.code || e.message}`);
        /* the CLI is about to exit: flush it, dirty() is debounced */
        try { this.store.save(); } catch (_) { /* the store writes itself later */ }
        /* stop pruning rather than reordering wildly; the snapshot stays listed */
        break;
      }
      versions.shift();
    }
  }

  async download(sha, dest) {
    const { repo, token } = this.settings();
    const urls = token
      ? [`${GH_API()}/repos/${repo}/tarball/${sha}`, `${GH_TAR()}/${repo}/tar.gz/${sha}`]
      : [`${GH_TAR()}/${repo}/tar.gz/${sha}`, `${GH_API()}/repos/${repo}/tarball/${sha}`];
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: ghHeaders(token), redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len && len > MAX_ARCHIVE) throw new Error(`archive too large (${len} bytes)`);
        const chunks = [];
        let got = 0;
        for await (const chunk of Readable.fromWeb(res.body)) {
          got += chunk.length;
          if (got > MAX_ARCHIVE) throw new Error('archive exceeded the size limit while downloading');
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(dest, buf);
        return { url, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
      } catch (e) {
        lastErr = e;
        this.log('warn', `download from ${url.replace(/\/tarball\/.*/, '/tarball/…')} failed: ${e.message}`);
      }
    }
    throw new Error(`could not download the archive: ${lastErr ? lastErr.message : 'unknown error'}`);
  }

  /**
   * Unpack the release archive.
   *
   * Our own reader does the work, because on some hosts the system tar cannot
   * create files at all — open(2) comes back ENOSYS and every entry reports
   * "Cannot open: Function not implemented" — even though Node writes to the
   * same directory without complaint (the archive itself was just saved there).
   * tar stays as a second attempt, for the opposite case where an archive uses
   * something our reader does not know about.
   */
  extract(archive, dir, sha) {
    fs.mkdirSync(dir, { recursive: true });
    let skipped = [];
    try {
      const result = archiveUtil.extractFile(archive, dir);
      skipped = result.skipped || [];
      this.log('info', `unpacked with the built-in reader: ${result.files} file(s), ` +
        `${(result.bytes / 1024).toFixed(0)} kB${skipped.length ? `, ${skipped.length} entry(s) skipped` : ''}`);
    } catch (nodeErr) {
      this.log('warn', `the built-in reader could not unpack the archive (${nodeErr.message}); trying tar`);
      const r = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8' });
      if (r.error && r.error.code === 'ENOENT') {
        throw new Error(`could not unpack the archive: ${nodeErr.message}; and the "tar" command ` +
          `is not installed on this server either (${archiveUtil.describeFilesystem(dir)})`);
      }
      if (r.status !== 0) {
        throw new Error(`could not unpack the archive: ${nodeErr.message}; tar also failed: ` +
          `${(r.stderr || '').trim().slice(0, 300)} — the staging directory is on ` +
          `${archiveUtil.describeFilesystem(dir)}`);
      }
    }
    if (skipped.length) {
      this.warnings = this.warnings || [];
      for (const item of skipped) this.warnings.push(`archive entry skipped: ${item.path} (${item.reason})`);
    }
    const entries = fs.readdirSync(dir).filter(n => !n.startsWith('.'));
    if (entries.length !== 1) throw new Error('unexpected archive layout');
    const top = path.join(dir, entries[0]);
    /* the archive directory carries the commit sha — that is what binds the
       bytes on disk to the commit we resolved */
    if (sha && !entries[0].toLowerCase().includes(sha8(sha).toLowerCase())) {
      throw new Error(`archive directory "${entries[0]}" does not match commit ${sha8(sha)}`);
    }
    return top;
  }

  smokeTest(tree) {
    const selftest = path.join(tree, 'server', 'selftest.js');
    if (!fs.existsSync(selftest)) throw new Error('the archive has no server/selftest.js to verify');
    const r = spawnSync(process.execPath, [selftest], {
      cwd: tree, encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { MEOW_SMOKE: '1', MEOW_APP_DIR: tree, MEOW_DATA_DIR: path.join(this.cfg.dataDir, 'smoke') }),
    });
    if (r.status !== 0) {
      throw new Error(`smoke test failed: ${((r.stdout || '') + (r.stderr || '')).trim().slice(0, 300)}`);
    }
    return String(r.stdout || '').trim().split('\n').slice(-1)[0] || 'ok';
  }

  /** Install a specific commit (or the current branch tip when no sha is given). */
  async install(opts) {
    if (this.running) return this.running;
    this.running = this._install(opts).finally(() => { this.running = null; });
    return this.running;
  }

  async _install(opts) {
    opts = opts || {};
    this.warnings = [];
    const { repo, branch, token } = this.settings();
    const started = Date.now();
    this.log('info', `update check started for ${repo}@${branch}`);

    let sha = opts.sha;
    let version = opts.version;
    if (!sha) {
      const c = await this.check();
      if (c.error) throw new Error(c.error);
      if (!c.remote) throw new Error('could not resolve the remote version');
      sha = c.remote.sha;
      version = c.remote.version;
      if (c.sameSha) return { ok: true, changed: false, message: `already running ${version} (${sha8(sha)})`, installed: this.installed() };
    }
    if (!version) {
      try {
        const raw = await fetch(`${GH_RAW()}/${repo}/${sha}/VERSION`, { redirect: 'follow' });
        version = raw.ok ? (await raw.text()).trim() : null;
      } catch (e) { version = null; }
      version = version || 'unknown';
    }

    const stamp = `${Date.now()}-${process.pid}`;
    const stageRoot = path.join(this.cfg.stagingDir, `in-${stamp}`);
    this.ensureDir(stageRoot);
    const archive = path.join(stageRoot, 'src.tar.gz');
    let tree = null;
    try {
      const dl = await this.download(sha, archive);
      this.log('info', `downloaded ${(dl.bytes / 1024).toFixed(0)} kB from ${dl.url.includes('codeload') ? 'codeload' : 'api'}`);
      const unpackDir = path.join(stageRoot, 'unpacked');
      tree = this.extract(archive, unpackDir, sha);

      const stagedVersion = fs.existsSync(path.join(tree, 'VERSION'))
        ? fs.readFileSync(path.join(tree, 'VERSION'), 'utf8').trim() : null;
      if (!stagedVersion) throw new Error('the archive has no VERSION file');
      if (version && stagedVersion !== version) {
        throw new Error(`version mismatch: archive says ${stagedVersion}, the API said ${version}`);
      }
      version = stagedVersion;

      const smoke = this.smokeTest(tree);
      this.log('info', `smoke test passed on staged copy: ${smoke}`);

      /* from here on we are changing the live install */
      const appOwner = ownerOf(this.cfg.appDir);      // who owns the live tree now
      this.backup(`before ${version}`, opts.kind || 'upgrade');
      copyTree(tree, this.cfg.appDir, {});
      const removed = removeExtras(tree, this.cfg.appDir);
      fs.writeFileSync(this.cfg.versionFile, version + '\n');
      /* A root-run update must leave the deployed tree owned by the service
         account, exactly as it was before — otherwise the panel's own updater
         can no longer write there, and the next root run cannot read the store. */
      if (isRoot() && appOwner) {
        chownTree(this.cfg.appDir, appOwner);
        try { fs.chownSync(this.cfg.versionFile, appOwner.uid, appOwner.gid); } catch (e) {}
      }

      this.store.data.app = {
        version, sha, installedAt: Date.now(),
        source: opts.auto ? 'auto-update' : 'admin',
        previousVersion: this.store.data.app.version,
      };
      this.store.dirty();
      this.log('info', `installed v${version} (${sha8(sha)})${removed ? `, ${removed} stale file(s) removed` : ''}`);
      this.store.audit('admin', 'update-install', `v${version} ${sha8(sha)} in ${Date.now() - started} ms`);

      return {
        ok: true, changed: true, version, sha, shortSha: sha8(sha),
        removedStaleFiles: removed,
        backupTaken: true,
        restartRequired: true,
        warnings: this.warnings.slice(),
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      this.log('error', `update failed: ${e.message}`);
      this.store.audit('admin', 'update-failed', e.message);
      throw e;
    } finally {
      if (!opts.keepStaging) fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  /** Restore a backup produced by a previous install. */
  async rollback(ref) {
    this.warnings = [];
    const versions = this.store.data.versions;
    let entry = null;
    if (ref) {
      entry = versions.slice().reverse().find(v =>
        (v.sha && (v.sha === ref || sha8(v.sha) === ref)) || v.version === ref || (v.dir && path.basename(v.dir) === ref));
    } else {
      entry = versions.slice().reverse().find(v => v.dir && fs.existsSync(v.dir) && !(v.sha && v.sha === this.store.data.app.sha));
    }
    if (!entry || !entry.dir) throw new Error('no backup available to roll back to');
    if (!fs.existsSync(entry.dir)) throw new Error(`the backup for ${entry.version} is gone from disk`);
    if (entry.sha && entry.sha === this.store.data.app.sha) throw new Error('that backup is the version already running');

    const appOwner = ownerOf(this.cfg.appDir);
    this.backup(`before rollback to ${entry.version}`, 'pre-rollback');
    copyTree(entry.dir, this.cfg.appDir, {});
    removeExtras(entry.dir, this.cfg.appDir);
    fs.writeFileSync(this.cfg.versionFile, entry.version + '\n');
    if (isRoot() && appOwner) {
      chownTree(this.cfg.appDir, appOwner);
      try { fs.chownSync(this.cfg.versionFile, appOwner.uid, appOwner.gid); } catch (e) {}
    }
    this.store.data.app = {
      version: entry.version,
      sha: entry.sha || '',
      installedAt: Date.now(),
      source: 'rollback',
      restoredFrom: entry.dir || null,     // so the panel can say which row is running
    };
    this.store.save();
    /* Bookkeeping after the swap is deliberately non-fatal: the files are already
       restored and the service still has to be restarted, so a failure to append
       history must not turn a successful rollback into an error. */
    try {
      this.store.data.versions.push({
        version: entry.version, sha: entry.sha || '', dir: null, installedAt: Date.now(), kind: 'rollback-target',
      });
      this.store.dirty();
      this.log('info', `rolled back to v${entry.version}${entry.sha ? ` (${sha8(entry.sha)})` : ''}`);
      this.store.audit('admin', 'rollback', `v${entry.version} ${sha8(entry.sha)}`);
    } catch (e) {
      console.error(`[updater] rollback bookkeeping failed: ${e.message}`);
    }
    return { ok: true, version: entry.version, sha: entry.sha || '', restartRequired: true, warnings: this.warnings.slice() };
  }

  /**
   * Align the store with the tree that is actually on disk.
   *
   * The VERSION file is the truth about what is deployed; the store only records
   * how it got there. So when a deployment by the installer (or by hand) does not
   * match the store, we adopt the file — and snapshot the tree the first time we
   * see a version, which is what makes a rollback possible from day one.
   */
  adoptInstalledTree() {
    const fileVersion = this.readVersionFile();
    if (!fileVersion) return null;
    const cur = this.store.data.app;
    if (cur.version === fileVersion) return null;
    const from = `${cur.version}${cur.sha ? ` (${sha8(cur.sha)})` : ''}`;
    this.store.data.app = {
      version: fileVersion,
      sha: '',                                   // no longer tied to a commit we know
      installedAt: Date.now(),
      source: 'installer',
      previousVersion: cur.version,
    };
    const dir = path.join(this.cfg.versionsDir, `install-${fileVersion}-local`);
    if (!fs.existsSync(dir)) {
      try {
        this.ensureDir(dir);
        copyTree(this.cfg.appDir, dir, {});
        if (isRoot()) chownTree(dir, this.dataOwner());
        this.store.data.versions.push({ version: fileVersion, sha: '', dir, installedAt: Date.now(), kind: 'install' });
      } catch (e) {
        this.log('warn', `could not snapshot the installed tree: ${e.message}`);
      }
    }
    this.store.dirty();
    this.log('info', `deployed version is v${fileVersion} on disk (store said ${from}) — adopted`);
    return this.store.data.app;
  }

  /** Record what the installer deployed, so the very first rollback works. */
  registerInstall(version, sha, source) {
    this.store.data.app = { version: version || this.readVersionFile() || '0.0.0', sha: sha || '', installedAt: Date.now(), source: source || 'installer' };
    this.store.data.versions.push({
      version: this.store.data.app.version,
      sha: sha || '',
      dir: path.join(this.cfg.versionsDir, `install-${this.store.data.app.version}-${sha8(sha) || 'local'}`),
      installedAt: Date.now(),
      kind: 'install',
    });
    /* the install-time snapshot of the tree, if the installer made one */
    const entry = this.store.data.versions[this.store.data.versions.length - 1];
    const dir = entry.dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      copyTree(this.cfg.appDir, dir, {});
    }
    this.store.dirty();
    return this.store.data.app;
  }

  logTail(n) {
    return this.store.data.updateLog.slice(-(n || 60));
  }
}

module.exports = { Updater, parseVersion, compareVersions, copyTree, removeExtras, dirSize, sha8 };
