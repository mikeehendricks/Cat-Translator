'use strict';
/**
 * Ownership preservation.
 *
 * The service runs as an unprivileged user (meow), but several operations are
 * meant to be run as root: the installer, and `sudo meow-translator update`.
 * Anything root writes into the data directory or the application directory
 * comes out owned by root — and the service then cannot read its own store,
 * which looks exactly like the data has vanished.
 *
 * So every write path that can run as root hands the result back to whoever
 * owns the surrounding directory. This is the whole fix: match the neighbour.
 */
const fs = require('node:fs');

/** uid/gid of `refPath`, or null when it cannot be determined. */
function ownerOf(refPath) {
  try {
    const st = fs.statSync(refPath);
    return { uid: st.uid, gid: st.gid };
  } catch (e) {
    return null;
  }
}

/**
 * Give `target` the same owner as `refPath`.
 * No-op when we are not root (an unprivileged process cannot chown, and does not
 * need to: it can only have written files it already owns).
 */
function matchOwner(target, refPath) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const owner = ownerOf(refPath);
  if (!owner) return false;
  try {
    fs.chownSync(target, owner.uid, owner.gid);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Give a whole tree a specific owner. Used after an update swaps the
 * application directory: the new files arrive owned by whoever ran the update,
 * but they must end up owned by whoever owned the previous ones.
 */
function chownTree(target, owner) {
  if (!owner || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const apply = (p) => {
    try { fs.chownSync(p, owner.uid, owner.gid); } catch (e) { /* one failure is not fatal */ }
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    const path = require('node:path');
    for (const ent of entries) {
      const child = path.join(p, ent.name);
      if (ent.isDirectory()) apply(child);
      else { try { fs.chownSync(child, owner.uid, owner.gid); } catch (e) {} }
    }
  };
  apply(target);
  return true;
}

/**
 * Who the service runs as, worked out from what is on the machine.
 *
 * matchOwner works by matching the neighbour, which is right for a file written
 * into an existing directory — but there is no neighbour to match when the
 * directory itself is the thing being created. A root-run command on a box whose
 * data directory has gone missing would create it as root, and the service would
 * then fail to start with EACCES on its own store.
 *
 * So the account is looked for directly, in order of how much it can be trusted:
 * an explicit name, the application directory (the installer gives it to the
 * service account), and the config file, which is deliberately root-owned and
 * readable by the service's group.
 */
function passwdEntries() {
  try {
    return fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter(Boolean).map(line => {
      const [name, , uid, gid] = line.split(':');
      return { name, uid: Number(uid), gid: Number(gid) };
    }).filter(u => Number.isInteger(u.uid) && u.uid > 0);
  } catch (e) {
    return [];
  }
}

function uidForUser(name) {
  const entry = passwdEntries().find(u => u.name === name);
  return entry ? { uid: entry.uid, gid: entry.gid } : null;
}

function userForGid(gid) {
  const entry = passwdEntries().find(u => u.gid === gid);
  return entry ? { uid: entry.uid, gid } : null;
}

function serviceOwner(opts) {
  const options = opts || {};
  const configPath = options.configPath || process.env.MEOW_CONFIG || '/etc/meow-translator/config.json';
  const name = options.user || process.env.MEOW_SERVICE_USER;
  if (name) {
    const byName = uidForUser(name);
    if (byName) return byName;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && cfg.appDir) {
      const own = ownerOf(cfg.appDir);
      if (own && own.uid !== 0) return own;
    }
  } catch (e) { /* no config readable from here */ }
  const confOwn = ownerOf(configPath);
  if (confOwn && confOwn.gid !== 0) {
    const byGroup = userForGid(confOwn.gid);
    if (byGroup) return byGroup;
  }
  if (options.dataDir) {
    const own = ownerOf(options.dataDir);
    if (own && own.uid !== 0) return own;
  }
  return null;
}

/** Give a path to a known owner. No-op unless we are root and have an owner. */
function giveTo(target, owner) {
  if (!owner || !isRoot()) return false;
  try { fs.chownSync(target, owner.uid, owner.gid); return true; } catch (e) { return false; }
}

/** matchOwner for a whole tree, files and directories alike. */
function matchOwnerTree(target, refPath) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const owner = ownerOf(refPath);
  if (!owner) return false;
  const apply = (p) => {
    try { fs.chownSync(p, owner.uid, owner.gid); } catch (e) { /* ignore a single failure */ }
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const child = require('node:path').join(p, ent.name);
      if (ent.isDirectory()) apply(child);
      else { try { fs.chownSync(child, owner.uid, owner.gid); } catch (e) {} }
    }
  };
  apply(target);
  return true;
}

/** True when this process is root, i.e. when the above matters. */
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

module.exports = {
  matchOwner, matchOwnerTree, chownTree, ownerOf, isRoot,
  serviceOwner, giveTo, uidForUser, userForGid,
};
