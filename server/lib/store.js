'use strict';
/**
 * Persistence: one JSON document, written atomically.
 *
 * No database dependency on purpose — the installer then has nothing to fetch,
 * and a backup is literally one file. Writes go to a temp file and are renamed,
 * so a crash mid-save can never leave a half-written store behind.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isRoot, giveTo, ownerOf, serviceOwner } = require('./fsowner');

const SCHEMA = 1;

function freshStore() {
  return {
    schema: SCHEMA,
    createdAt: Date.now(),
    /* One-time registration: the admin account is created by whoever holds the
       setup token, then this flag latches. */
    setup: {
      token: crypto.randomBytes(24).toString('base64url'),
      used: false,
      usedAt: null,
      usedFrom: null,
    },
    admin: null,                 // { username, salt, hash, params, createdAt, updatedAt }
    sessions: [],                // { id, csrf, createdAt, lastSeen, ip, ua }
    settings: {
      storeRawIp: true,          // false -> keep a salted hash only (privacy mode)
      retentionDays: 90,
      geoLookup: true,
      /* When the address arriving at this server is private (a router, a
         container network, a rewriting proxy), the visitor's browser is asked
         for the address the world sees it from. See lib/clientip.js. */
      reportVisitorIp: true,
      /* Who may speak for the visitor. null = whatever the config file says
         (the installer writes "auto" or "on"); a panel choice is kept here. */
      trustProxy: null,
      publicIpEndpoints: [],     // empty -> the built-in list; edit in the panel
      autoCheckUpdates: true,
      autoInstallUpdates: false,
      updateChannel: 'main',     // branch name in the GitHub repo
      githubRepo: 'mikeehendricks/Cat-Translator',
      githubToken: '',           // only needed for private forks / rate limits
      publicBaseUrl: '',
    },
    visits: [],                  // { t, ip, hash, path, ua, ref, device, geo }
    geoCache: {},                // ip -> { status, country, cc, region, city, isp, ts }
    geoPending: [],              // ips queued for lookup (survives a restart)
    dayStats: {},                // 'YYYY-MM-DD' -> { hits, uniques, countries:{} }
    app: {                       // what is deployed right now
      version: '0.0.0',
      sha: '',
      installedAt: 0,
      source: 'installer',
    },
    versions: [],                // install/rollback history with backup dirs
    updateCheck: null,           // cache of the last GitHub check (so pages need no network)
    updateLog: [],               // { t, level, message }
    audit: [],                   // admin actions
    loginFails: {},              // ipHash -> { count, until }
    counters: { starts: 0, lastStart: 0 },
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = freshStore();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = Object.assign(freshStore(), raw);
      /* nested objects need their own merge so a store written by an older
         version still gets new settings keys with sane defaults */
      this.data.settings = Object.assign(freshStore().settings, raw.settings || {});
      this.data.setup = Object.assign(freshStore().setup, raw.setup || {});
      this.data.app = Object.assign(freshStore().app, raw.app || {});
      this.data.counters = Object.assign(freshStore().counters, raw.counters || {});
      this.data.counters.starts = (this.data.counters.starts || 0) + 1;
      this.data.counters.lastStart = Date.now();
      this.data.schema = SCHEMA;
      this.dirty();
    } catch (e) {
      /* A permission problem is an operator error with a one-line fix, and it
         must not be mistaken for a corrupt file — starting fresh here would look
         like the credentials and visit log had vanished. Say what to do instead. */
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        throw new Error(
          `cannot read ${this.file}: ${e.message}\n` +
          `        the service must own its data directory. Fix it with:\n` +
          `          sudo chown -R meow:meow ${path.dirname(this.file)} && sudo systemctl restart meow-translator`,
        );
      }
      if (e.code !== 'ENOENT') {
        const broken = `${this.file}.broken-${Date.now()}`;
        try { fs.renameSync(this.file, broken); } catch (_) {}
        console.error(`[store] unreadable store moved to ${broken}: ${e.message}`);
      }
      this.data = freshStore();
      this.data.counters.starts = 1;
      this.data.counters.lastStart = Date.now();
      this.save();
    }
    return this.data;
  }

  /** Write immediately. Use this for anything that must survive a crash —
   *  a created account, a changed password, a saved setting. */
  flush() { this.save(); }

  /** Mark dirty; the actual write is coalesced to avoid hammering the disk. */
  dirty() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.save(); }, 400);
    if (this._timer.unref) this._timer.unref();
  }

  save() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      const dir = path.dirname(this.file);
      /* When root runs a CLI command the store must still end up belonging to the
         service account, or the service cannot read it on the next start. Match
         the neighbour when there is one; when the directory itself is being
         created there is nothing to match, so ask who the service runs as. */
      let owner = null;
      if (isRoot()) {
        const existed = fs.existsSync(dir);
        owner = serviceOwner({ dataDir: dir }) || ownerOf(path.dirname(dir));
        fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
        if (!existed) giveTo(dir, owner);
      }
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      if (isRoot()) giveTo(this.file, owner || ownerOf(dir));
    } catch (e) {
      const hint = (e.code === 'EACCES' || e.code === 'EPERM')
        ? `\n        the service user must be able to write ${path.dirname(this.file)} (sudo chown -R meow:meow ${path.dirname(this.file)})`
        : '';
      throw new Error(`cannot write ${this.file}: ${e.message}${hint}`);
    }
    this._dirty = false;
  }

  /* ------------------------------------------------------------------ visits */

  prune() {
    const s = this.data.settings;
    if (s.retentionDays > 0) {
      const cut = Date.now() - s.retentionDays * 86400000;
      const before = this.data.visits.length;
      this.data.visits = this.data.visits.filter(v => v.t >= cut);
      if (this.data.visits.length !== before) this.dirty();
    }
    if (this.data.visits.length > 50000) {
      this.data.visits.splice(0, this.data.visits.length - 50000);
      this.dirty();
    }
    /* geo cache entries are tiny but unbounded in principle */
    const keys = Object.keys(this.data.geoCache);
    if (keys.length > 20000) {
      for (const k of keys.slice(0, keys.length - 20000)) delete this.data.geoCache[k];
      this.dirty();
    }
    if (this.data.audit.length > 5000) this.data.audit.splice(0, this.data.audit.length - 5000);
    if (this.data.updateLog.length > 500) this.data.updateLog.splice(0, this.data.updateLog.length - 500);
  }

  log(level, message) {
    this.data.updateLog.push({ t: Date.now(), level, message: String(message).slice(0, 500) });
    this.dirty();
  }

  audit(who, action, detail, ip) {
    this.data.audit.push({ t: Date.now(), who, action, detail: detail || '', ip: ip || '' });
    this.dirty();
  }

  /* ------------------------------------------------------------------- admin */

  setAdmin(username, password, auth) {
    const rec = auth.hashPassword(password);
    this.data.admin = Object.assign({ username, createdAt: Date.now() }, rec, { updatedAt: Date.now() });
    this.data.setup.used = true;
    this.data.setup.usedAt = Date.now();
    this.save();                       // losing a fresh account to a crash is not acceptable
  }
}

module.exports = { Store, freshStore, SCHEMA };
