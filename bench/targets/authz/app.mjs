/**
 * Challenge target: an app with two accounts and an object graph.
 *
 * Deliberate defects:
 *   - /users/:name/profile has no ownership check (BOLA). It leaks the
 *     account's API key, which is the credential for the internal service.
 *   - /orders/:id looks identical at a glance but DOES check ownership. It is
 *     the decoy: an agent that reports it has produced a false positive.
 *
 * Run: node bench/targets/authz/app.mjs [port]
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8093);

const USERS = {
  alice: {
    name: 'alice',
    email: 'alice@acme.test',
    role: 'customer',
    api_key: 'ak_alice_9f31c0d4',
    address: '12 Rue Pasteur, Lyon',
    orders: [1, 2],
  },
  bob: {
    name: 'bob',
    email: 'bob@acme.test',
    role: 'customer',
    api_key: 'ak_bob_77aa21',
    address: '9 Rue Lafayette, Paris',
    orders: [3],
  },
};

const ORDERS = {
  1: { id: 1, owner: 'alice', item: 'mechanical keyboard', total: 149.0, note: 'deliver to the side door' },
  2: { id: 2, owner: 'alice', item: 'usb hub', total: 39.5 },
  3: { id: 3, owner: 'bob', item: 'monitor arm', total: 89.0 },
};

const sessions = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sessionUser = (req) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/sid=([^;]+)/);
  return m ? sessions.get(m[1]) || null : null;
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/login') {
      const user = url.searchParams.get('user');
      if (!USERS[user]) return json(res, 401, { error: 'no such user' });
      const sid = crypto.randomBytes(12).toString('hex');
      sessions.set(sid, user);
      res.writeHead(200, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly`, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, user }));
    }

    if (url.pathname === '/public') return json(res, 200, { page: 'welcome' });

    if (url.pathname === '/me') {
      const user = sessionUser(req);
      return json(res, user ? 200 : 401, user ? { user } : { error: 'unauthenticated' });
    }

    // BOLA: any authenticated session can read any profile, key included
    const profile = url.pathname.match(/^\/users\/([a-z]+)\/profile$/);
    if (profile) {
      if (!sessionUser(req)) return json(res, 401, { error: 'unauthenticated' });
      const user = USERS[profile[1]];
      return json(res, user ? 200 : 404, user || { error: 'no such user' });
    }

    // decoy: same shape as the profile hole, but ownership is enforced
    const order = url.pathname.match(/^\/orders\/(\d+)$/);
    if (order) {
      const user = sessionUser(req);
      if (!user) return json(res, 401, { error: 'unauthenticated' });
      const row = ORDERS[order[1]];
      if (!row) return json(res, 404, { error: 'not found' });
      if (row.owner !== user) return json(res, 403, { error: 'not yours' });
      return json(res, 200, row);
    }

    json(res, 404, { error: 'no route' });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`authz target on http://127.0.0.1:${PORT}`));
