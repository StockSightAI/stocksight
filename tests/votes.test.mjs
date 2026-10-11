// Community votes (api/community.js)
import crypto from 'node:crypto';
const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const login = async (email, password) => (await (await fetch(B + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', email, password }) })).json()).token;
const vote = async (ticker, v, tok) => {
  const r = await fetch(B + '/api/community', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify({ action: 'vote', ticker, vote: v }) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const counts = async (ticker, tok) => (await fetch(B + '/api/community?votes=' + encodeURIComponent(ticker), { headers: tok ? { Authorization: 'Bearer ' + tok } : {} })).json();
const anon = (path, init = {}) => fetch(B + '/fakesb/rest/v1/' + path, { ...init, headers: { apikey: 'sb_publishable_x', 'Content-Type': 'application/json', ...(init.headers || {}) } });

let c = await counts('NVDA');
ok(c.total === 6 && c.buy === 1 && c.sell === 5 && c.mine === null, 'counts without sign-in', c);

const tok = await login('legacy-sha@test.dev', 'password1');
c = await counts('NVDA', tok);
ok(c.mine === 'buy', 'vote made the old way still belongs to its owner', c);

let r = await vote('NVDA', 'sell');
ok(r.status === 401, 'vote without sign-in refused', r);
r = await vote('NVDA', 'sell', 'garbage.token');
ok(r.status === 401, 'vote with a forged token refused', r);
r = await vote('NVDA', 'moon', tok);
ok(r.status === 400, 'invalid vote refused', r);
r = await vote("X');alert(1)//", 'buy', tok);
ok(r.status === 400, 'invalid ticker refused', r);

r = await vote('NVDA', 'hold', tok);
ok(r.status === 200 && r.mine === 'hold' && r.total === 6 && r.hold === 1 && r.buy === 0, 'changing a vote replaces it (no extra vote)', r);
for (let i = 0; i < 5; i++) await vote('NVDA', 'buy', tok);
c = await counts('NVDA', tok);
ok(c.total === 6 && c.buy === 1 && c.mine === 'buy', 'voting again and again still counts once', c);

r = await vote('AAPL', 'buy', tok);
c = await counts('AAPL', tok);
ok(c.total === 1 && c.mine === 'buy', 'new ticker vote', c);

// The voter id the server stores is the same formula the site used before
const d = await (await fetch(B + '/__db')).json();
const mine = d.tables.votes.filter(v => v.voter_hash === crypto.createHash('sha256').update('stocksight-vote:legacy-sha@test.dev').digest('hex'));
ok(mine.length === 2 && !d.tables.votes.some(v => v.voter_hash.includes('@')), 'one row per ticker, no email stored', mine);

// Direct access with the public key is blocked (after the lockdown SQL)
ok((await anon('votes', { method: 'POST', body: JSON.stringify({ ticker: 'NVDA', voter_hash: 'x', vote: 'buy' }) })).status === 401, 'anon vote insert blocked');
ok((await anon('vote_counts?select=*')).status === 401, 'anon vote_counts read blocked');

// Search and trending still work through the merged endpoint
r = await fetch(B + '/api/community', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9' }, body: JSON.stringify({ action: 'search', ticker: 'AMD' }) });
ok(r.status === 204, 'search logged', r.status);
const t = await (await fetch(B + '/api/community?trending=1&days=1')).json();
ok(Array.isArray(t.trending) && t.trending.length > 0, 'trending', t);
ok((await fetch(B + '/api/search?days=1')).status === 404, 'old /api/search endpoint gone');

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
