// Sign-in, sessions, password reset, Google and the account row (api/auth.js, api/user.js)
const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { failN++; console.log('FAIL', label, extra !== undefined ? JSON.stringify(extra) : ''); } };
const auth = async (body, tok) => {
  const r = await fetch(B + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const me = async (tok, method = 'GET', body) => {
  const r = await fetch(B + '/api/user', { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const dump = async () => (await fetch(B + '/__db')).json();
const row = async email => (await dump()).tables.users.find(u => u.email === email);
const anon = async (path, init = {}) => fetch(B + '/fakesb/rest/v1/' + path, { ...init, headers: { apikey: 'sb_publishable_x', 'Content-Type': 'application/json', ...(init.headers || {}) } });

// sign up
let r = await auth({ action: 'signup', name: 'Tess<script>', email: 'New.User@Test.dev', password: 'hunter22' });
ok(r.status === 200 && r.token && r.user.email === 'new.user@test.dev', 'signup ok', r);
ok(r.user?.name === 'Tessscript', 'signup name cleaned', r.user);
const t1 = r.token;
let db = await row('new.user@test.dev');
ok(db?.phash?.startsWith('scrypt$'), 'signup stores scrypt', db?.phash);
r = await auth({ action: 'signup', name: 'X', email: 'new.user@test.dev', password: 'whatever1' });
ok(r.status === 409 && r.code === 'exists', 'duplicate signup blocked', r);
r = await auth({ action: 'signup', name: 'X', email: 'bad', password: 'whatever1' });
ok(r.status === 400, 'bad email rejected', r);
r = await auth({ action: 'signup', name: 'X', email: 'short@test.dev', password: '123' });
ok(r.status === 400, 'short password rejected', r);

// user row access
r = await me(t1);
ok(r.status === 200 && r.user.email === 'new.user@test.dev' && !('phash' in r.user) && !('reset_token' in r.user) && r.user.has_password === true, 'GET /api/user hides secrets', r);
r = await me(null);
ok(r.status === 401, 'GET without token 401', r);
r = await me(t1.slice(0, -3) + 'abc');
ok(r.status === 401, 'tampered token 401', r);
const forged = Buffer.from(JSON.stringify({ e: 'legacy-sha@test.dev', v: 0, exp: Date.now() + 1e9 })).toString('base64url') + '.' + t1.split('.')[1];
r = await me(forged);
ok(r.status === 401, 'forged payload with other sig 401', r);
r = await me(t1, 'POST', { patch: { watchlist: ['MSFT', 'NVDA'], phash: 'sha256:evil', email: 'x@y.z', token_version: 9, reset_token: 'x', name: 'Tess' } });
ok(r.status === 200, 'patch ok', r);
db = await row('new.user@test.dev');
ok(JSON.stringify(db.watchlist) === '["MSFT","NVDA"]' && db.phash.startsWith('scrypt$') && db.token_version === 0 && !db.reset_token && db.name === 'Tess', 'patch whitelist enforced', db);

// login + legacy upgrade
r = await auth({ action: 'login', email: 'new.user@test.dev', password: 'wrongpass' });
ok(r.status === 401 && r.code === 'wrong', 'wrong password 401', r);
r = await auth({ action: 'login', email: 'NEW.user@test.dev', password: 'hunter22' });
ok(r.status === 200 && r.token, 'login ok', r);
r = await auth({ action: 'login', email: 'nobody@test.dev', password: 'hunter22' });
ok(r.status === 401 && r.code === 'no_account', 'unknown account', r);
r = await auth({ action: 'login', email: 'legacy-sha@test.dev', password: 'password1' });
ok(r.status === 200 && r.user.name === 'Shaun Test', 'legacy sha login', r);
ok((await row('legacy-sha@test.dev')).phash.startsWith('scrypt$'), 'legacy sha upgraded');
r = await auth({ action: 'login', email: 'legacy-sha@test.dev', password: 'password1' });
ok(r.status === 200, 'login after upgrade', r);
r = await auth({ action: 'login', email: 'legacy-djb@test.dev', password: 'password2' });
ok(r.status === 200 && r.user.mode === 'advanced', 'legacy djb login', r);
ok((await row('legacy-djb@test.dev')).phash.startsWith('scrypt$'), 'legacy djb upgraded');
r = await auth({ action: 'login', email: 'google-only@test.dev', password: 'anything' });
ok(r.status === 401 && r.code === 'google', 'google-only password login refused', r);

// google
r = await auth({ action: 'google', accessToken: 'fake:google-only@test.dev' });
ok(r.status === 200 && r.user.email === 'google-only@test.dev' && r.user.hasPassword === false, 'google existing', r);
const tg = r.token;
r = await auth({ action: 'google', accessToken: 'fake:brand.new@test.dev' });
ok(r.status === 200 && r.user.name === 'Googler', 'google new user, name from userinfo', r);
ok((await row('brand.new@test.dev'))?.google_id, 'google id saved');
r = await auth({ action: 'google', idToken: 'fake:idtok@test.dev' });
ok(r.status === 200 && r.user.name === 'Idtok', 'google id token', r);
r = await auth({ action: 'google', accessToken: 'fake:attacker@test.dev:someone-elses-client' });
ok(r.status === 401, 'google token for another app refused', r);
r = await auth({ action: 'google', accessToken: 'garbage' });
ok(r.status === 401, 'bad google token refused', r);
r = await auth({ action: 'signup', name: 'G', email: 'google-only@test.dev', password: 'newpass1' });
ok(r.status === 409 && r.code === 'google', 'signup on google email blocked', r);
r = await auth({ action: 'google', accessToken: 'fake:legacy-sha@test.dev' });
ok(r.status === 200 && r.user.hasPassword === true, 'google links to password account', r);

// change password: google-only can add one, password users need current
r = await auth({ action: 'change-password', password: 'gpass123' }, tg);
ok(r.status === 200 && r.token, 'google user sets password', r);
const tg2 = r.token;
r = await me(tg);
ok(r.status === 401, 'old google session revoked after password set', r);
r = await me(tg2);
ok(r.status === 200 && r.user.has_password, 'new session works', r);
r = await auth({ action: 'login', email: 'google-only@test.dev', password: 'gpass123' });
ok(r.status === 200, 'google user can now log in by password', r);
r = await auth({ action: 'change-password', current: 'nope', password: 'hunter33' }, t1);
ok(r.status === 403, 'change with wrong current 403', r);
r = await auth({ action: 'change-password', current: 'hunter22', password: 'hunter33' }, t1);
ok(r.status === 200 && r.token, 'change password ok', r);
const t1b = r.token;
r = await me(t1);
ok(r.status === 401, 'old session revoked after change', r);
r = await auth({ action: 'login', email: 'new.user@test.dev', password: 'hunter33' });
ok(r.status === 200, 'login with new password', r);

// reset
r = await auth({ action: 'reset-request', email: 'nobody@test.dev' });
ok(r.status === 404, 'reset unknown 404', r);
r = await auth({ action: 'reset-request', email: 'new.user@test.dev' });
ok(r.status === 200, 'reset request ok', r);
let d = await dump();
const code = d.codes['new.user@test.dev'];
db = d.tables.users.find(u => u.email === 'new.user@test.dev');
ok(/^\d{6}$/.test(code) && db.reset_token && db.reset_token !== code && db.reset_token.length === 64, 'code stored hashed, not plain', { code, tok: db.reset_token });
const wrong = code === '000000' ? '111111' : '000000';
r = await auth({ action: 'reset-confirm', email: 'new.user@test.dev', code: wrong, password: 'resetpw1' });
ok(r.status === 400 && /Incorrect/.test(r.error), 'wrong code', r);
r = await auth({ action: 'reset-confirm', email: 'new.user@test.dev', code, password: 'resetpw1' });
ok(r.status === 200 && r.token, 'reset confirm ok', r);
r = await me(t1b);
ok(r.status === 401, 'reset revokes old sessions', r);
r = await auth({ action: 'reset-confirm', email: 'new.user@test.dev', code, password: 'resetpw2' });
ok(r.status === 400, 'code single-use', r);
r = await auth({ action: 'login', email: 'new.user@test.dev', password: 'resetpw1' });
ok(r.status === 200, 'login after reset', r);
let t3 = r.token;
// brute force cap
r = await auth({ action: 'reset-request', email: 'legacy-djb@test.dev' });
d = await dump();
const c2 = d.codes['legacy-djb@test.dev'];
for (let i = 0; i < 5; i++) await auth({ action: 'reset-confirm', email: 'legacy-djb@test.dev', code: String((+c2 + 1 + i) % 1e6).padStart(6, '0'), password: 'zzzzzz1' });
r = await auth({ action: 'reset-confirm', email: 'legacy-djb@test.dev', code: c2, password: 'zzzzzz1' });
ok(r.status === 400 && /Too many/.test(r.error), 'code locked after 5 wrong tries', r);

// leaderboard via server
r = await me(t3, 'POST', { leaderboard: { value: 10234.567, return_pct: 2.34, holdings_count: 3 } });
ok(r.status === 200, 'leaderboard upsert', r);
d = await dump();
let lb = d.tables.pt_leaderboard.find(x => x.email === 'new.user@test.dev');
ok(lb && lb.display_name === 'new***' && lb.value === 10234.57, 'leaderboard row', lb);
r = await me(t3, 'POST', { leaderboard: { value: 'lots', return_pct: 1, holdings_count: 1 } });
ok(r.status === 400, 'bad leaderboard rejected', r);
r = await me(t3, 'POST', { leaderboard: null });
d = await dump();
ok(!d.tables.pt_leaderboard.find(x => x.email === 'new.user@test.dev'), 'leaderboard leave');

// anon key can't touch users (simulated lockdown) but can read the board
ok((await anon('users?select=*')).status === 401, 'anon users read blocked');
ok((await anon('users', { method: 'POST', body: JSON.stringify({ email: 'x@y.z' }) })).status === 401, 'anon users write blocked');
ok((await anon('pt_leaderboard?select=display_name')).status === 200, 'anon leaderboard read ok');

// delete
r = await auth({ action: 'delete', password: 'nope', confirm: 'DELETE' }, t3);
ok(r.status === 403, 'delete wrong password', r);
r = await auth({ action: 'delete', password: 'resetpw1', confirm: 'nah' }, t3);
ok(r.status === 400, 'delete needs DELETE', r);
r = await auth({ action: 'delete', password: 'resetpw1', confirm: 'DELETE' }, t3);
ok(r.status === 200, 'delete ok', r);
ok(!(await row('new.user@test.dev')), 'row gone');
r = await me(t3);
ok(r.status === 401, 'deleted user session dead', r);
r = await auth({ action: 'google', accessToken: 'fake:brand.new@test.dev' });
r = await auth({ action: 'delete', confirm: 'DELETE' }, r.token);
ok(r.status === 200, 'google-only delete without password', r);

// misc
r = await auth({ action: 'nope' });
ok(r.status === 400, 'unknown action', r);
r = await fetch(B + '/api/auth').then(x => x.status);
ok(r === 405, 'GET auth 405', r);

// login rate limit
let last;
for (let i = 0; i < 11; i++) last = await auth({ action: 'login', email: 'legacy-sha@test.dev', password: 'bad' + i });
ok(last.status === 429, 'login rate limited', last);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
