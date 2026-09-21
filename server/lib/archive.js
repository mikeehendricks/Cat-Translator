#!/usr/bin/env node
'use strict';
/**
 * Reading and writing tar archives with nothing but the standard library.
 *
 * Why this exists. The updater unpacks the release archive, and it used to do
 * that by shelling out to the system `tar`. On some hosts that fails in a way
 * no amount of retrying fixes: every entry comes back with
 *
 *     tar: Cat-Translator-<sha>/CHANGELOG.md: Cannot open: Function not implemented
 *
 * which is open(2) returning ENOSYS — what a seccomp profile, a user namespace,
 * or an exotic filesystem does to a syscall it does not implement. The archive
 * itself had already been downloaded and written to disk by Node in the very
 * same directory, so the filesystem plainly accepts Node's writes: it is tar's
 * child process that is being refused. Doing the unpacking here removes the
 * dependency on a program we do not control, and removes a class of failures
 * with it.
 *
 * Also fixed by unpacking here rather than by piping tar: the three-lines-long
 * security story. Entries are checked one by one, and an archive that tries to
 * write outside the destination — an absolute path, a `..` segment, a symlink
 * pointing at /etc — is refused rather than half-applied.
 *
 * Command line, used by install.sh and useful on its own:
 *
 *   node server/lib/archive.js extract <archive.tar.gz> <dir>
 *   node server/lib/archive.js create  <dir> <archive.tar.gz> [exclude…]
 *   node server/lib/archive.js copy    <dir> <dir> [exclude…]
 *   node server/lib/archive.js list    <archive.tar.gz>
 *
 * Each command prints a one-line JSON summary on stdout.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLOCK = 512;
const MAX_UNPACKED = 256 * 1024 * 1024;   // an unpacked release is ~5 MB
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

/* --------------------------------------------------------------- decoding */

function readString(buf, start, end) {
  let stop = start;
  while (stop < end && buf[stop] !== 0) stop++;
  return buf.toString('utf8', start, stop);
}

function readNumber(buf, start, len) {
  /* GNU writes numbers too large for octal in base 256, high bit set. */
  if (buf[start] & 0x80) {
    let value = buf[start] & 0x7f;
    for (let i = start + 1; i < start + len; i++) value = value * 256 + buf[i];
    return value;
  }
  const text = buf.toString('ascii', start, start + len).replace(/\0.*$/, '').trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function headerChecksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
  return sum;
}

/* PAX records look like "27 path=some/long/path\n". */
function parsePax(data) {
  const out = {};
  const text = data.toString('utf8');
  let off = 0;
  while (off < text.length) {
    const space = text.indexOf(' ', off);
    if (space === -1) break;
    const len = parseInt(text.slice(off, space), 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > text.length) break;
    const record = text.slice(space + 1, off + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    off += len;
  }
  return out;
}

/** Iterate the entries of an uncompressed tar buffer. */
function* entries(buffer) {
  let off = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  while (off + BLOCK <= buffer.length) {
    const header = buffer.subarray(off, off + BLOCK);
    off += BLOCK;
    /* two zero blocks (one is enough in practice) end the archive */
    let empty = true;
    for (let i = 0; i < BLOCK; i++) if (header[i] !== 0) { empty = false; break; }
    if (empty) break;

    const size = readNumber(header, 124, 12);
    const data = buffer.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(header[156] || 0x30);

    if (headerChecksum(header) !== readNumber(header, 148, 8)) {
      throw new Error('the archive is corrupt: header checksum mismatch');
    }

    if (type === 'x' || type === 'g') {
      const parsed = parsePax(data);
      if (type === 'x') pax = parsed;                      // applies to the next entry
      continue;
    }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'K') { longLink = data.toString('utf8').replace(/\0+$/, ''); continue; }

    const prefix = readString(header, 345, 500);
    const base = readString(header, 0, 100);
    const name = pax.path || longName || (prefix ? prefix + '/' + base : base);
    const linkname = pax.linkpath || longLink || readString(header, 157, 257);

    const entry = {
      name,
      linkname,
      type: type === '\0' ? '0' : type,
      size,
      mode: readNumber(header, 100, 8) & 0o7777,
      mtime: readNumber(header, 136, 12),
      data,
    };
    longName = null;
    longLink = null;
    pax = {};
    yield entry;
  }
}

/* ------------------------------------------------------------- safety */

/**
 * Turn an entry name into a path that is guaranteed to stay inside the
 * destination, or null if it cannot be. Anything absolute, anything with a `..`
 * segment, anything that looks like a Windows drive: refused.
 */
function safeRelPath(name) {
  let raw = String(name || '').replace(/\\/g, '/');
  while (raw.startsWith('./')) raw = raw.slice(2);
  if (!raw || raw === '.' || raw.startsWith('/')) return null;
  const parts = raw.split('/').filter(s => s && s !== '.');
  if (!parts.length) return null;
  if (parts.some(s => s === '..')) return null;
  if (/^[a-zA-Z]:/.test(parts[0])) return null;
  return parts.join('/');
}

/* ------------------------------------------------------------ extraction */

function gunzip(buffer, opts) {
  const limit = (opts && opts.maxUnpacked) || MAX_UNPACKED;
  return zlib.gunzipSync(buffer, { maxOutputLength: limit });
}

function looksGzipped(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Unpack a tar buffer into destDir. Returns a summary:
 *   { files, dirs, symlinks, bytes, skipped: [{ path, reason }], top }
 * `top` is the single top-level directory name, when there is exactly one —
 * which is the layout a GitHub archive has.
 */
function extractBuffer(buffer, destDir, opts) {
  const options = opts || {};
  fs.mkdirSync(destDir, { recursive: true });
  const summary = { files: 0, dirs: 0, symlinks: 0, bytes: 0, skipped: [], top: null };
  const tops = new Set();
  const dirModes = [];

  for (const entry of entries(buffer)) {
    /* an archive made with `tar -cf x.tar .` starts with an entry for the
       directory it was made from — that is the destination itself, not a
       problem to be refused */
    const rawName = String(entry.name || '').replace(/\\/g, '/').trim();
    if (rawName === '' || rawName === '.' || rawName === './') continue;

    const rel = safeRelPath(entry.name);
    if (!rel) {
      throw new Error(`refusing to unpack ${JSON.stringify(entry.name)}: it points outside the destination`);
    }
    tops.add(rel.split('/')[0]);
    const relPath = rel;
    const dest = path.join(destDir, relPath);

    if (entry.type === '5') {
      fs.mkdirSync(dest, { recursive: true });
      dirModes.push([dest, entry.mode]);
      summary.dirs++;
      continue;
    }

    if (entry.type === '0') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const mode = entry.mode || DEFAULT_FILE_MODE;
      fs.writeFileSync(dest, entry.data, { mode });
      try { fs.chmodSync(dest, mode); } catch (_) { /* keep the umask default */ }
      if (entry.mtime) { try { fs.utimesSync(dest, entry.mtime, entry.mtime); } catch (_) { /* optional */ } }
      summary.files++;
      summary.bytes += entry.data.length;
      continue;
    }

    if (entry.type === '2') {
      const target = entry.linkname;
      if (!target || path.isAbsolute(target) || target.split('/').includes('..')) {
        summary.skipped.push({ path: relPath, reason: `symlink to ${target} — outside the archive` });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.symlinkSync(target, dest); summary.symlinks++; }
      catch (err) { summary.skipped.push({ path: relPath, reason: `symlink: ${err.code || err.message}` }); }
      continue;
    }

    if (entry.type === '1') {
      const from = safeRelPath(entry.linkname) && path.join(destDir, safeRelPath(entry.linkname));
      try {
        if (!from) throw new Error('bad link target');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.linkSync(from, dest);
        summary.files++;
      } catch (err) {
        summary.skipped.push({ path: relPath, reason: `hard link: ${err.code || err.message}` });
      }
      continue;
    }

    /* devices, fifos and anything else: not something a release archive needs */
    summary.skipped.push({ path: relPath, reason: `entry type "${entry.type}" is not unpacked` });
  }

  /* directory permissions last, deepest first, so a read-only directory does
     not stop its own contents from being written */
  for (let i = dirModes.length - 1; i >= 0; i--) {
    const [dir, mode] = dirModes[i];
    try { fs.chmodSync(dir, mode || DEFAULT_DIR_MODE); } catch (_) { /* best effort */ }
  }

  summary.top = tops.size === 1 ? Array.from(tops)[0] : null;
  return summary;
}

function extractFile(file, destDir, opts) {
  const buffer = fs.readFileSync(file);
  const tar = looksGzipped(buffer) ? gunzip(buffer, opts) : buffer;
  return extractBuffer(tar, destDir, opts);
}

/** List an archive without unpacking it. */
function listFile(file) {
  const buffer = fs.readFileSync(file);
  const tar = looksGzipped(buffer) ? gunzip(buffer) : buffer;
  const out = [];
  for (const entry of entries(tar)) out.push({ name: entry.name, type: entry.type, size: entry.size });
  return out;
}

/* --------------------------------------------------------------- packing */

function normalizeExcludes(patterns) {
  return (patterns || []).map(p => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
}

function isExcluded(relPath, patterns) {
  if (!patterns.length) return false;
  const base = path.basename(relPath);
  for (const pattern of patterns) {
    if (relPath === pattern || base === pattern) return true;
    if (relPath.startsWith(pattern + '/')) return true;
  }
  return false;
}

function octal(value, length) {
  const text = value.toString(8);
  return '0'.repeat(Math.max(0, length - 1 - text.length)) + text + '\0';
}

function header(fields, size) {
  const buf = Buffer.alloc(BLOCK);
  const name = Buffer.byteLength(fields.name);
  if (name <= 100) buf.write(fields.name, 0, 'utf8');
  else buf.write(fields.name.slice(-100), 0, 'utf8');   // long names get a GNU record instead
  buf.write(octal(fields.mode, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');                  // uid: the tar file is not the owner
  buf.write(octal(0, 8), 116, 'ascii');                  // gid
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(fields.mtime, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');                   // checksum placeholder
  buf.write(fields.type, 156, 'ascii');
  buf.write(fields.linkname || '', 157, 'utf8');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  buf.write('meow-translator', 265, 'ascii');
  buf.write('meow-translator', 297, 'ascii');
  buf.write(octal(0, 8), 329, 'ascii');
  buf.write(octal(0, 8), 337, 'ascii');
  buf.write(octal(headerChecksum(buf), 8), 148, 'ascii');
  return buf;
}

function pad(data) {
  const remainder = data.length % BLOCK;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}

function walk(dir, root, patterns, out) {
  const items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (isExcluded(rel, patterns)) continue;
    if (item.isDirectory()) {
      out.push({ type: '5', name: rel + '/', full });
      walk(full, root, patterns, out);
    } else if (item.isSymbolicLink()) {
      out.push({ type: '2', name: rel, full, linkname: fs.readlinkSync(full) });
    } else if (item.isFile()) {
      out.push({ type: '0', name: rel, full });
    }
  }
  return out;
}

/** Pack a directory into a .tar.gz. */
function createFile(srcDir, outFile, opts) {
  const options = opts || {};
  const patterns = normalizeExcludes(options.exclude);
  const items = walk(srcDir, srcDir, patterns, []);
  const parts = [];
  let bytes = 0;
  for (const item of items) {
    const stat = fs.statSync(item.full);
    const mode = stat.mode & 0o777;
    /* a path that will not fit in the 100-character name field gets a GNU
       long-name record, exactly as tar does it */
    if (item.type !== '2' && Buffer.byteLength(item.name) > 100) {
      const nameData = Buffer.from(item.name + '\0', 'utf8');
      parts.push(header({ name: '././@LongLink', mode: 0o644, mtime: Math.floor(stat.mtimeMs / 1000), type: 'L' }, nameData.length));
      parts.push(pad(nameData));
    }
    if (item.type === '0') {
      const data = fs.readFileSync(item.full);
      parts.push(header({ name: item.name, mode, mtime: Math.floor(stat.mtimeMs / 1000), type: '0' }, data.length));
      parts.push(pad(data));
      bytes += data.length;
    } else if (item.type === '5') {
      parts.push(header({ name: item.name, mode, mtime: Math.floor(stat.mtimeMs / 1000), type: '5' }, 0));
    } else {
      parts.push(header({ name: item.name, mode, mtime: Math.floor(stat.mtimeMs / 1000), type: '2', linkname: item.linkname }, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));                    // end of archive
  const tarball = Buffer.concat(parts);
  fs.writeFileSync(outFile, zlib.gzipSync(tarball, { level: 9 }));
  return { files: items.filter(i => i.type === '0').length, entries: items.length, bytes };
}

/**
 * Copy a directory tree, preserving modes and symlinks. Used by the installer
 * so that a host where tar cannot create files can still be installed on.
 */
function copyTree(srcDir, destDir, opts) {
  const options = opts || {};
  const patterns = normalizeExcludes(options.exclude);
  const summary = { files: 0, dirs: 0, symlinks: 0, bytes: 0, skipped: [] };

  const visit = (src, dest, rel) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, item.name);
      const to = path.join(dest, item.name);
      const relPath = rel ? rel + '/' + item.name : item.name;
      if (isExcluded(relPath, patterns)) continue;
      if (item.isDirectory()) {
        summary.dirs++;
        visit(from, to, relPath);
        try { fs.chmodSync(to, fs.statSync(from).mode & 0o7777); } catch (_) { /* best effort */ }
      } else if (item.isSymbolicLink()) {
        const target = fs.readlinkSync(from);
        try { fs.rmSync(to, { force: true }); } catch (_) { /* nothing there */ }
        try { fs.symlinkSync(target, to); summary.symlinks++; }
        catch (err) { summary.skipped.push({ path: relPath, reason: `symlink: ${err.code || err.message}` }); }
      } else if (item.isFile()) {
        fs.copyFileSync(from, to);
        try { fs.chmodSync(to, fs.statSync(from).mode & 0o7777); } catch (_) { /* best effort */ }
        summary.files++;
        summary.bytes += fs.statSync(from).size;
      }
    }
  };

  visit(srcDir, destDir, '');
  return summary;
}

/** Name the filesystem a directory lives on — for error messages that help. */
function describeFilesystem(dir) {
  const KNOWN = {
    0xef53: 'ext2/3/4', 0x58465342: 'XFS', 0x9123683e: 'btrfs', 0x01021994: 'tmpfs',
    0x794c7630: 'overlayfs', 0x6969: 'NFS', 0xff534d42: 'CIFS/SMB', 0x65735546: 'FUSE',
    0x9fa0: 'procfs', 0x62656572: 'sysfs', 0x1021994: 'tmpfs', 0x4d44: 'FAT',
    0x1badb002: 'overlay', 0x6a656a63: 'gVisor',
  };
  try {
    if (typeof fs.statfsSync !== 'function') return 'unknown';
    const st = fs.statfsSync(dir);
    const type = Number(st.type) >>> 0;
    const name = KNOWN[type];
    return name ? `${name} (0x${type.toString(16)})` : `type 0x${type.toString(16)}`;
  } catch (err) {
    return `unavailable (${err.code || err.message})`;
  }
}

module.exports = {
  extractBuffer,
  extractFile,
  listFile,
  createFile,
  copyTree,
  describeFilesystem,
  safeRelPath,
  estimate: listFile,
  MAX_UNPACKED,
};

/* ------------------------------------------------------------- command line */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  const fail = (message) => { console.error('archive: ' + message); process.exit(1); };
  const summarise = (summary) => {
    const line = Object.assign({ ok: true, command }, summary);
    if (summary.skipped && summary.skipped.length) {
      line.skipped = summary.skipped.slice(0, 20);
      for (const s of summary.skipped) console.error(`  skipped ${s.path}: ${s.reason}`);
    }
    console.log(JSON.stringify(line));
  };
  try {
    if (command === 'extract') {
      const [file, dest] = argv;
      if (!file || !dest) fail('usage: archive.js extract <archive.tar.gz> <dir>');
      summarise(extractFile(file, dest));
    } else if (command === 'create') {
      const [src, out] = argv;
      if (!src || !out) fail('usage: archive.js create <dir> <archive.tar.gz> [exclude…]');
      summarise(createFile(src, out, { exclude: argv.slice(2) }));
    } else if (command === 'copy') {
      const [src, dest] = argv;
      if (!src || !dest) fail('usage: archive.js copy <dir> <dir> [exclude…]');
      summarise(copyTree(src, dest, { exclude: argv.slice(2) }));
    } else if (command === 'list') {
      const [file] = argv;
      if (!file) fail('usage: archive.js list <archive.tar.gz>');
      console.log(JSON.stringify({ ok: true, command, entries: listFile(file).length }));
    } else {
      fail('usage: archive.js extract|create|copy|list …');
    }
  } catch (err) {
    fail(err.message);
  }
}
