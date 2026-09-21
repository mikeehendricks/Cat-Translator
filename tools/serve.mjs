/* Serves the shipped single-file app at / so it can be opened in a browser tab. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = process.env.PORT || 8000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = url === '/' ? 'cat-translator.html' : url.replace(/^\/+/, '');
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`meow translator on http://0.0.0.0:${PORT}/`));
