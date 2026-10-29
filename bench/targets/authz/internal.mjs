/**
 * Challenge target: an internal admin service, reachable only with the API key
 * leaked by the app. This is the second hop of the pivot.
 *
 * Run: node bench/targets/authz/internal.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8094);
const ADMIN_KEY = 'ak_alice_9f31c0d4';
const FLAG = 'ARACHNID{PIVOT_ADMIN_OK}';

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/internal/admin') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no route' }));
    }
    const key = req.headers['x-api-key'] || '';
    if (key !== ADMIN_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing or invalid api key' }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-service': 'internal-admin' });
    res.end(JSON.stringify({ ok: true, scope: 'admin', flag: FLAG }));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`internal admin on http://127.0.0.1:${PORT}`));
