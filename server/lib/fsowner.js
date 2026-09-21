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

module.exports = { matchOwner, matchOwnerTree, chownTree, ownerOf, isRoot };
