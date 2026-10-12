// Fake backend for tests and local work. Nothing here talks to production Supabase, Resend or Google.
//   node tests/fake-backend.mjs        then open http://localhost:5053 (PORT=... to change)
//  - /fakesb/rest/v1/*  a tiny in-memory PostgREST stand-in, locked down like production
//                       (users, searches and votes only answer to the service key)
//  - /api/*             the real Vercel handlers, with JSON bodies parsed like Vercel does
//  - /                  the site, with SUPABASE_URL pointed at the fake
//  - /__db              everything in the fake database, plus captured emails and reset codes
//  - /__yahoo?down=1    makes Yahoo Finance fail, to test the "digest not sent" path
// Yahoo Finance and CNN are real network calls; the economic calendar, Google and Resend are faked.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 5053;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = `http://localhost:${PORT}/fakesb`;
process.env.SUPABASE_URL = FAKE;
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
delete process.env.SESSION_SECRET; // exercises the service-key fallback
process.env.AUTH_DEV_LOG_CODES = '1';
process.env.RESEND_API_KEY = 're_test_fake_key';
process.env.DIGEST_BASE_URL = `http://localhost:${PORT}`;
delete process.env.CRON_SECRET;
process.env.DIGEST_REPORT_TO = 'owner@test.dev';
process.env.DIGEST_MAILING_ADDRESS = 'PO Box 1, Testville, ST 00000';
let yahooDown = false;
const GOOGLE_CLIENT_ID = '215107020140-9n8h7eaor1fl1rlvtnjf1vg5l6upu4ei.apps.googleusercontent.com';

// Reset codes printed by the handler are kept here so tests can read them
export const codes = {};
export const mail = [];
const _log = console.log;
console.log = (...a) => {
  const m = String(a[0]).match(/^\[dev\] reset code for (\S+): (\d{6})/);
  if (m) codes[m[1]] = m[2];
  _log(...a);
};

// Google token checks answered locally: tokens look like "fake:<email>:<aud>"
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    const q = new URL(u).searchParams;
    const tok = q.get('access_token') || q.get('id_token') || '';
    const [, email, aud] = tok.split(':');
    if (!tok.startsWith('fake:') || !email) return new Response('{"error":"invalid_token"}', { status: 400 });
    return Response.json({ aud: aud || GOOGLE_CLIENT_ID, azp: aud || GOOGLE_CLIENT_ID, email, email_verified: 'true', sub: 'g-' + email.length, ...(q.get('id_token') ? { given_name: 'Idtok' } : {}) });
  }
  if (u.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return Response.json({ given_name: 'Googler', name: 'Googler Test' });
  if (yahooDown && u.includes('finance.yahoo.com')) return new Response('down', { status: 503 });
  // The Forex Factory feed rate-limits repeated test runs; serve a sample week (tests only)
  if (u.includes('nfs.faireconomy.media')) {
    if (u.includes('nextweek')) return new Response('not found', { status: 404 });
    const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    return Response.json([
      { title: 'CPI m/m', country: 'USD', date: `${day(3)}T08:30:00-04:00`, impact: 'High', forecast: '0.3%', previous: '0.4%' },
      { title: 'Core CPI m/m', country: 'USD', date: `${day(3)}T08:30:00-04:00`, impact: 'High', forecast: '0.3%', previous: '0.3%' },
      { title: 'Retail Sales m/m', country: 'USD', date: `${day(5)}T08:30:00-04:00`, impact: 'High', forecast: '0.5%', previous: '0.6%' },
      { title: 'FOMC Meeting Minutes', country: 'USD', date: `${day(4)}T14:00:00-04:00`, impact: 'High', forecast: '', previous: '' },
      { title: 'Unemployment Claims', country: 'USD', date: `${day(5)}T08:30:00-04:00`, impact: 'Medium', forecast: '228K', previous: '231K' },
      { title: 'German ZEW', country: 'EUR', date: `${day(3)}T05:00:00-04:00`, impact: 'High', forecast: '', previous: '' },
    ]);
  }
  // Resend is answered locally: emails are recorded, never sent
  if (u.startsWith('https://api.resend.com/emails/batch')) {
    const arr = JSON.parse(opts.body);
    arr.forEach(m => mail.push({ ...m, idem: opts.headers?.['Idempotency-Key'] || null }));
    return Response.json({ data: arr.map((_, i) => ({ id: 'fake-' + mail.length + '-' + i })) });
  }
  if (u.startsWith('https://api.resend.com/emails')) {
    const m = JSON.parse(opts.body);
    const c = String(m.html).match(/letter-spacing:12px;color:#a29bfe">(\d{6})</);
    if (c) codes[m.to] = c[1];
    mail.push(m);
    return Response.json({ id: 'fake-single' });
  }
  if (u.startsWith('https://api.resend.com')) throw new Error('Unexpected Resend call');
  if (u.includes('supabase.co')) throw new Error('Production Supabase must not be called in tests: ' + u);
  return realFetch(url, opts);
};

/* ── fake PostgREST ── */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const legacy = s => { let h = 0; for (const c of s) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; } return 'h' + Math.abs(h).toString(36); };
const now = () => new Date().toISOString();
const tables = {
  users: [
    { email: 'legacy-sha@test.dev', name: 'Shaun Test', phash: 'sha256:' + sha('password1'), mode: 'simple', created_at: now(), token_version: 0, reset_attempts: 0, digest: true,
      watchlist: [{ ticker: 'NVDA', name: 'Nvidia', type: 's' }, { ticker: 'TSLA', name: 'Tesla', type: 's' }, { ticker: 'ETH', name: 'Ethereum', type: 'c' }, { ticker: 'SPX', name: 'S&P 500', type: 'i' }, { ticker: 'BRK.B', name: 'Berkshire', type: 's' }, { ticker: 'NFLX', name: 'Netflix', type: 's' }],
      portfolio: { holdings: [{ ticker: 'AAPL', shares: 10, buyPrice: 150, type: 's', name: 'Apple' }, { ticker: 'VOO', shares: 5, buyPrice: 400, type: 's' }, { ticker: 'AAPL', shares: 2, buyPrice: 200, type: 's' }, { ticker: 'BTC', shares: 0.05, buyPrice: 30000, type: 'c' }],
        paper_trade: { cash: 3500, holdings: { MSFT: { shares: 10 }, BTC: { shares: 0.02 } } } } },
    { email: 'bare@test.dev', name: '', phash: '', mode: 'simple', created_at: now(), token_version: 0, reset_attempts: 0, digest: true },
    { email: 'legacy-djb@test.dev', name: 'Dee', phash: legacy('password2'), mode: 'advanced', created_at: now(), token_version: 0, reset_attempts: 0 },
    { email: 'google-only@test.dev', name: 'Gina', phash: '', google_id: 'g-999', mode: 'simple', created_at: now(), token_version: 0, reset_attempts: 0 },
  ],
  // Seeded searches: real interest from several people, one spammer, a fake ticker and an injection attempt
  searches: [
    ...[['NVDA', 'a'], ['NVDA', 'b'], ['NVDA', 'c'], ['TSLA', 'a'], ['TSLA', 'd'], ['PLTR', 'b'], ['PLTR', 'e'], ['AAPL', 'a'], ['AAPL', 'b'], ['AAPL', 'c'], ['AAPL', 'd'], ['HOOD', 'z']]
      .map(([t, p]) => ({ ticker: t, date: new Date().toISOString().slice(0, 10), ip_hash: 'seed-' + p })),
    ...Array.from({ length: 60 }, () => ({ ticker: 'SOFI', date: new Date().toISOString().slice(0, 10), ip_hash: 'spammer' })),
    ...['p', 'q', 'r'].map(p => ({ ticker: 'ZZQXW', date: new Date().toISOString().slice(0, 10), ip_hash: 'seed-' + p })),
    ...['p', 'q', 'r'].map(p => ({ ticker: "');ALERT(1);//", date: new Date().toISOString().slice(0, 10), ip_hash: 'seed-' + p })),
  ],
  // An existing vote made the old way (client-side hash of the email), plus stuffed votes
  votes: [
    { ticker: 'NVDA', voter_hash: sha('stocksight-vote:legacy-sha@test.dev'), vote: 'buy' },
    ...Array.from({ length: 5 }, (_, i) => ({ ticker: 'NVDA', voter_hash: 'stuffed' + i, vote: 'sell' })),
  ],
  pt_leaderboard: [{ email: 'someone@test.dev', display_name: 'som***', value: 10500, return_pct: 5, holdings_count: 2, updated_at: now() }],
};
const DEFAULTS = {
  users: () => ({ created_at: now(), token_version: 0, reset_attempts: 0, mode: 'simple' }), client_errors: () => ({ at: now() }),
  leagues: () => ({ id: crypto.randomUUID(), created_at: now() }), league_members: () => ({ joined_at: now() }),
};
const UNIQUE = {
  users: ['email'], pt_leaderboard: ['email'], searches: ['ticker', 'date', 'ip_hash'], votes: ['ticker', 'voter_hash'],
  leagues: ['code'], league_members: ['league_id', 'email'], xp_weeks: ['email', 'week'], league_results: ['league_id', 'week'],
};
const SERVICE_ONLY = new Set(['users', 'searches', 'votes', 'vote_counts', 'client_errors', 'leagues', 'league_members', 'xp_weeks', 'league_results']);
// Foreign keys with ON DELETE CASCADE in the real schema
const CASCADE = { leagues: [['league_members', 'league_id'], ['league_results', 'league_id']] };
// Supabase Storage stand-in: { 'avatars/x.jpg': { type, buf } }
const storage = {};

function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'limit', 'order', 'on_conflict', 'offset'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter(r => String(r[k]) === decodeURIComponent(v.slice(3)));
    if (v.startsWith('gte.')) out = out.filter(r => String(r[k]) >= decodeURIComponent(v.slice(4)));
    if (v.startsWith('lt.')) out = out.filter(r => String(r[k]) < decodeURIComponent(v.slice(3)));
    if (v === 'not.is.null') out = out.filter(r => r[k] != null);
    if (v.startsWith('in.(')) {
      const vals = decodeURIComponent(v.slice(4, -1)).match(/"[^"]*"|[^,]+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
      out = out.filter(r => vals.includes(String(r[k])));
    }
  }
  return out;
}
function project(rows, select) {
  if (!select || select === '*') return rows.map(r => ({ ...r }));
  const cols = select.split(',');
  return rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
}
function fakeRest(req, res, url, body) {
  const table = url.pathname.replace('/fakesb/rest/v1/', '');
  const key = req.headers.apikey || '';
  const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(data === undefined ? '' : JSON.stringify(data)); };
  if (SERVICE_ONLY.has(table) && key !== process.env.SUPABASE_SERVICE_KEY) return send(401, { code: '42501', message: `permission denied for table ${table}` });
  if (table === 'pt_leaderboard' && req.method !== 'GET' && key !== process.env.SUPABASE_SERVICE_KEY) return send(401, { code: '42501', message: 'permission denied for table pt_leaderboard' });
  // public.hit_rate_limit(p_key, p_max, p_window_seconds): the shared login-attempt counter
  if (table === 'rpc/hit_rate_limit') {
    if (key !== process.env.SUPABASE_SERVICE_KEY) return send(401, { code: '42501', message: 'permission denied for function hit_rate_limit' });
    const rl = (tables.rate_limits ||= []), t = Date.now();
    let r = rl.find(x => x.key === body.p_key);
    if (!r) { r = { key: body.p_key, hits: 0, reset_at: 0 }; rl.push(r); }
    if (r.reset_at < t) { r.hits = 0; r.reset_at = t + body.p_window_seconds * 1000; }
    r.hits++;
    return send(200, r.hits > body.p_max);
  }
  const rows = (tables[table] ||= []);
  const p = url.searchParams, prefer = req.headers.prefer || '';
  const wantRep = prefer.includes('return=representation');
  if (req.method === 'GET') {
    let out = filterRows(rows, p);
    const order = p.get('order');
    if (order) { const [c, dir] = order.split('.'); out = [...out].sort((a, b) => (dir === 'desc' ? -1 : 1) * (a[c] > b[c] ? 1 : -1)); }
    if (p.get('limit')) out = out.slice(0, +p.get('limit'));
    out = project(out, p.get('select'));
    if ((req.headers.accept || '').includes('vnd.pgrst.object')) return out.length === 1 ? send(200, out[0]) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
    return send(200, out);
  }
  if (req.method === 'POST') {
    const items = Array.isArray(body) ? body : [body];
    const uk = UNIQUE[table], merge = prefer.includes('merge-duplicates'), ignore = prefer.includes('ignore-duplicates'), saved = [];
    for (const it of items) {
      // Postgres unique indexes treat NULLs as distinct
      const hit = uk && uk.every(k => it[k] != null) && rows.find(r => uk.every(k => r[k] === it[k]));
      if (hit && ignore) continue;
      if (hit && !merge) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      if (hit) { Object.assign(hit, it); saved.push(hit); }
      else { const row = { ...(DEFAULTS[table]?.() || {}), ...it }; rows.push(row); saved.push(row); }
    }
    return wantRep ? send(201, saved) : send(201);
  }
  if (req.method === 'PATCH') {
    const hit = filterRows(rows, p);
    hit.forEach(r => Object.assign(r, body));
    return wantRep ? send(200, hit) : send(204);
  }
  if (req.method === 'DELETE') {
    const hit = new Set(filterRows(rows, p));
    tables[table] = rows.filter(r => !hit.has(r));
    for (const [child, col] of CASCADE[table] || []) {
      const ids = new Set([...hit].map(r => r.id));
      if (tables[child]) tables[child] = tables[child].filter(r => !ids.has(r[col]));
    }
    return send(204);
  }
  return send(405, { message: 'no' });
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBuf = Buffer.concat(chunks);
  if (url.pathname.startsWith('/fakesb/storage/v1/object/')) {
    const pub = url.pathname.match(/^\/fakesb\/storage\/v1\/object\/public\/(.+)$/);
    if (pub && req.method === 'GET') {
      const o = storage[decodeURIComponent(pub[1])];
      if (!o) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', o.type);
      return res.end(o.buf);
    }
    if ((req.headers.authorization || '') !== `Bearer ${process.env.SUPABASE_SERVICE_KEY}`) { res.statusCode = 403; return res.end('{"error":"Unauthorized"}'); }
    const key = decodeURIComponent(url.pathname.replace('/fakesb/storage/v1/object/', ''));
    if (req.method === 'DELETE') { delete storage[key]; res.statusCode = 200; return res.end('{}'); }
    if (req.method === 'POST' || req.method === 'PUT') { storage[key] = { type: req.headers['content-type'], buf: rawBuf }; res.statusCode = 200; return res.end(JSON.stringify({ Key: key })); }
  }
  const raw = rawBuf.toString();
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }

  if (url.pathname === '/__yahoo') { yahooDown = url.searchParams.get('down') === '1'; return res.end('yahoo down: ' + yahooDown); }
  // Test-only: add rows directly (for example a past week's XP), as POST { table, rows }
  if (url.pathname === '/__seed' && req.method === 'POST') { (tables[body.table] ||= []).push(...body.rows); res.statusCode = 204; return res.end(); }
  if (url.pathname === '/__db') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ tables, codes, mail, storage: Object.fromEntries(Object.entries(storage).map(([k, o]) => [k, { type: o.type, bytes: o.buf.length }])) })); }
  if (url.pathname.startsWith('/fakesb/rest/v1/')) return fakeRest(req, res, url, body);
  // vercel.json rewrite: /stock/:ticker -> /api/page?t=:ticker
  const stockPage = url.pathname.match(/^\/stock\/([^/]+)\/?$/);
  if (stockPage) url.searchParams.set('t', decodeURIComponent(stockPage[1]));
  // ... and /join/:code -> /api/page?league=:code, /leagues -> the app
  const joinPage = url.pathname.match(/^\/join\/([^/]+)\/?$/);
  if (joinPage) url.searchParams.set('league', decodeURIComponent(joinPage[1]));
  if (url.pathname === '/leagues' || url.pathname === '/learn') url.pathname = '/';
  if (url.pathname === '/privacy' || url.pathname === '/terms') url.pathname += '.html';
  const api = stockPage || joinPage ? [null, 'page'] : url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api && fs.existsSync(path.join(root, 'api', api[1] + '.js'))) {
    const { default: handler } = await import(pathToFileURL(path.join(root, 'api', api[1] + '.js')).href);
    req.query = Object.fromEntries(url.searchParams);
    req.body = body;
    const shim = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { res.statusCode = c; return shim; },
      json(b) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); },
      send(b) { res.end(b); },
      end(b) { res.end(b); },
    };
    try { return await handler(req, shim); } catch (e) { res.statusCode = 500; return res.end(String(e)); }
  }
  let p = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (url.pathname === '/') p = path.join(root, 'index.html');
  if (!p.startsWith(root + path.sep)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    // The app talks to the fake database instead of production
    if (p.endsWith('app.js') || p.endsWith('index.html')) data = Buffer.from(data.toString().replace("const SUPABASE_URL = 'https://fgcjbdqvnjzafgnahwai.supabase.co';", `const SUPABASE_URL = '${FAKE}';`));
    res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => _log(`fake backend on http://localhost:${PORT}`));
