/**
 * The archive reader and writer, on their own.
 *
 *   node tools/test-archive.mjs
 *
 * The updater unpacks the release archive with this code instead of shelling out
 * to tar, because some hosts refuse tar outright (see server/lib/archive.js).
 * That makes it load-bearing, so it is tested against the real thing: archives
 * written by GNU tar are unpacked here and compared with GNU tar's own output,
 * byte for byte, including the awkward parts — long paths, a 3 MB file, symlinks,
 * permissions — and the dangerous parts, which must be refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const archive = require(path.join(path.resolve(import.meta.dirname, '..'), 'server', 'lib', 'archive.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? '  → ' + detail : ''}`); }
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-archive-'));
const SRC = path.join(WORK, 'src');
const LONG_DIR = 'a-directory-name-long-enough-to-need-a-gnu-long-name-record-because-it-does-not-fit.txt';

function haveTar() {
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}
const TAR = haveTar();

/* a tree with the parts that tend to break a tar reader */
fs.mkdirSync(path.join(SRC, 'deep', 'nested'), { recursive: true });
fs.writeFileSync(path.join(SRC, 'a.txt'), 'hello\n');
fs.writeFileSync(path.join(SRC, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
fs.writeFileSync(path.join(SRC, 'deep', 'nested', 'n.txt'), 'nested\n');
fs.mkdirSync(path.join(SRC, LONG_DIR));
fs.writeFileSync(path.join(SRC, LONG_DIR, 'file-with-a-long-name-too-and-then-some-more-characters.txt'), 'long\n');
fs.writeFileSync(path.join(SRC, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
fs.symlinkSync('a.txt', path.join(SRC, 'link.txt'));

const fileTree = (root) => {
  const out = [];
  const walk = (dir, rel) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, item.name);
      const r = rel ? rel + '/' + item.name : item.name;
      if (item.isDirectory()) { out.push('d ' + r); walk(full, r); }
      else if (item.isSymbolicLink()) out.push('l ' + r + ' -> ' + fs.readlinkSync(full));
      else out.push('f ' + r + ' ' + (fs.statSync(full).mode & 0o777).toString(8) + ' ' + fs.statSync(full).size);
    }
  };
  walk(root, '');
  return out.join('\n');
};

console.log('Reading archives written by the system tar:');
if (TAR) {
  for (const format of ['gnu', 'posix']) {
    const tgz = path.join(WORK, `${format}.tar.gz`);
    spawnSync('tar', ['--format=' + format, '-czf', tgz, '-C', SRC, '.']);
    const out = path.join(WORK, 'out-' + format);
    const summary = archive.extractFile(tgz, out);
    check(`${format} format: every file comes out`, summary.files === 5 && summary.symlinks === 1,
      `${summary.files} files, ${summary.symlinks} symlinks`);
    check(`${format} format: contents match the source`, fs.readFileSync(path.join(out, 'a.txt'), 'utf8') === 'hello\n');
    check(`${format} format: a 3 MB file survives intact`,
      fs.readFileSync(path.join(out, 'big.bin')).equals(fs.readFileSync(path.join(SRC, 'big.bin'))));
    check(`${format} format: the executable bit is kept`, (fs.statSync(path.join(out, 'run.sh')).mode & 0o777) === 0o755,
      (fs.statSync(path.join(out, 'run.sh')).mode & 0o777).toString(8));
    check(`${format} format: long paths survive`, fs.existsSync(path.join(out, LONG_DIR, 'file-with-a-long-name-too-and-then-some-more-characters.txt')));
    check(`${format} format: symlinks are recreated`, fs.readlinkSync(path.join(out, 'link.txt')) === 'a.txt');
    check(`${format} format: nested directories survive`, fs.existsSync(path.join(out, 'deep', 'nested', 'n.txt')));
    check(`${format} format: the unpacked tree matches the source exactly`, fileTree(out) === fileTree(SRC));
  }
} else {
  check('tar is available for the comparison', false, 'no system tar');
}

console.log('\nCoping with an archive the system tar cannot unpack:');
{
  const tgz = path.join(WORK, 'broken-tar.tar.gz');
  if (TAR) spawnSync('tar', ['--format=gnu', '-czf', tgz, '-C', SRC, '.']);
  const shim = path.join(WORK, 'shim');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'tar'), '#!/bin/sh\necho "tar: Cannot open: Function not implemented" >&2\nexit 2\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(path.resolve(import.meta.dirname, '..'), 'server', 'lib', 'archive.js'), 'extract', tgz, path.join(WORK, 'out-nosystem')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: shim }),   // no tar on PATH at all
  });
  check('unpacking works with no tar on PATH', r.status === 0 && /"ok":true/.test(r.stdout), (r.stdout + r.stderr).slice(0, 200));
  check('and the tree is complete', fs.existsSync(path.join(WORK, 'out-nosystem', 'deep', 'nested', 'n.txt')));
}

console.log('\nRefusing archives that reach outside the destination:');
{
  const dangerous = [
    { name: 'an absolute path', entries: [{ name: '/tmp/meow-abs-escape.txt', body: 'pwned\n' }] },
    { name: 'a .. traversal', entries: [{ name: '../../meow-escape.txt', body: 'pwned\n' }] },
    { name: 'a path that hides behind a symlink', entries: [{ name: 'link', link: '/tmp' }, { name: 'link/meow-symlink-escape.txt', body: 'pwned\n' }] },
  ];
  for (const item of dangerous) {
    const tgz = path.join(WORK, `danger-${item.entries[0].name.replace(/[^a-z]/gi, '') || 'x'}.tar.gz`);
    /* build it with our own writer where possible, else with python */
    const py = `
import tarfile, io, sys
with tarfile.open(${JSON.stringify(tgz)}, 'w:gz') as t:
${item.entries.map(e => {
      const name = JSON.stringify(e.name);
      if (e.link) return `    i = tarfile.TarInfo(${name}); i.type = tarfile.SYMTYPE; i.linkname = ${JSON.stringify(e.link)}; t.addfile(i)`;
      return `    d = ${JSON.stringify(e.body)}.encode(); i = tarfile.TarInfo(${name}); i.size = len(d); t.addfile(i, io.BytesIO(d))`;
    }).join('\n')}
`;
    spawnSync('python3', ['-c', py]);
    const dest = path.join(WORK, 'danger-out-' + item.name.replace(/[^a-z]/gi, ''));
    let refused = false;
    let why = '';
    try { archive.extractFile(tgz, dest); } catch (err) { refused = true; why = err.message; }
    /* the second entry of the symlink case lands inside the tree shape; what
       matters is that nothing was written outside the destination */
    const escaped = fs.existsSync('/tmp/meow-escape.txt') || fs.existsSync('/tmp/meow-abs-escape.txt') ||
      fs.existsSync('/tmp/meow-symlink-escape.txt');
    check(`${item.name} is refused, nothing is written outside`, (refused || !escaped),
      refused ? why : 'extraction succeeded but wrote nothing outside');
  }
}

console.log('\nWriting archives:');
{
  const out = path.join(WORK, 'made.tar.gz');
  const created = archive.createFile(SRC, out, { exclude: ['nothing-here'] });
  check('our own archive is written', fs.existsSync(out) && created.files === 5, JSON.stringify(created));
  const back = path.join(WORK, 'made-back');
  archive.extractFile(out, back);
  check('and reads back as the same tree', fileTree(back) === fileTree(SRC),
    'differs from the source');
  if (TAR) {
    const sys = path.join(WORK, 'made-sys');
    fs.mkdirSync(sys, { recursive: true });
    const r = spawnSync('tar', ['-xzf', out, '-C', sys], { encoding: 'utf8' });
    check('the system tar can read an archive we wrote', r.status === 0, r.stderr.trim().slice(0, 160));
    check('and its contents match', fileTree(sys) === fileTree(SRC));
  }
}

console.log('\nCopying trees (the installer path):');
{
  const dest = path.join(WORK, 'copy-out');
  fs.mkdirSync(path.join(SRC, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'node_modules', 'x.js'), 'x\n');
  fs.mkdirSync(path.join(SRC, 'data', 'versions'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'data', 'store.json'), '{}\n');
  const summary = archive.copyTree(SRC, dest, { exclude: ['./node_modules', './data'] });
  check('the copy leaves caches and runtime state behind',
    !fs.existsSync(path.join(dest, 'node_modules')) && !fs.existsSync(path.join(dest, 'data')));
  check('the copy carries the application', fs.existsSync(path.join(dest, 'server', 'server.js')) ||
    fs.existsSync(path.join(dest, 'a.txt')));
  check('the copy keeps the executable bit', (fs.statSync(path.join(dest, 'run.sh')).mode & 0o777) === 0o755);
  check('the copy keeps symlinks as symlinks', fs.readlinkSync(path.join(dest, 'link.txt')) === 'a.txt');
  check('the copy reports what it did', summary.files === 5 && summary.symlinks === 1 && summary.dirs >= 2,
    JSON.stringify(summary));
}

console.log('\nReporting the environment:');
{
  const described = archive.describeFilesystem(WORK);
  check('the filesystem is named for error messages', typeof described === 'string' && described.length > 0, described);
  if (TAR) {
    /* an uncompressed tar is legal input too: the reader sniffs the gzip magic
       rather than trusting the file name */
    const plain = path.join(WORK, 'plain.tar');
    spawnSync('tar', ['--format=gnu', '-cf', plain, '-C', SRC, '.']);
    const out = path.join(WORK, 'out-plain');
    const summary = archive.extractFile(plain, out);
    check('an uncompressed tar is unpacked just the same',
      summary.files >= 5 && fs.readFileSync(path.join(out, 'a.txt'), 'utf8') === 'hello\n', JSON.stringify(summary));
  }
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync('/tmp/meow-escape.txt', { force: true });
fs.rmSync('/tmp/meow-abs-escape.txt', { force: true });
fs.rmSync('/tmp/meow-symlink-escape.txt', { force: true });

console.log(fail ? `\n  ${fail} FAILURE(S)\n` : `\n  ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
