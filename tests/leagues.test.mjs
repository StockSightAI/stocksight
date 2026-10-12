// Friend leagues (create, join, boards, weekly XP, owner tools, Monday results) and profile photos
const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const post = (path, body, tok) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
const get = (path, tok) => fetch(B + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
const dump = async () => (await fetch(B + '/__db')).json();
const signup = async (email, name) => (await (await post('/api/auth', { action: 'signup', name, email, password: 'secret99' })).json()).token;
const league = (tok, body) => post('/api/community', body, tok);
const save = (tok, patch) => post('/api/user', { patch }, tok);
const weekKey = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const lastWeek = weekKey(Date.now() - 7 * 864e5), thisWeek = weekKey();

const ana = await signup('ana@test.dev', 'Ana Lopez'), ben = await signup('ben@test.dev', 'Ben Park'), cy = await signup('cy@test.dev', 'Cy'), dee = await signup('dee@test.dev', 'Dee Ray');

// Create and join
let r = await league(ana, { action: 'league-create', name: 'x' });
ok(r.status === 400, 'league needs a real name', r.status);
r = await league(null, { action: 'league-create', name: 'Roommates' });
ok(r.status === 401, 'leagues need a sign-in', r.status);
r = await (await league(ana, { action: 'league-create', name: '  Roommates <b> ' })).json();
const code = r.code;
ok(/^[A-Z2-9]{6}$/.test(code) && r.name === 'Roommates b', 'league created with a 6-character code, name cleaned', r);
let inv = await (await get('/api/community?invite=' + code)).json();
ok(inv.name === 'Roommates b' && inv.members === 1 && inv.by === 'Ana L.' && !JSON.stringify(inv).includes('@'), 'invite preview: name, size and who, no emails', inv);
ok((await get('/api/community?invite=ZZZZZZ')).status === 404, 'unknown invite code: 404');
ok((await league(ben, { action: 'league-join', code: 'ZZZZZZ' })).status === 404, 'joining a wrong code fails');
ok((await (await league(ben, { action: 'league-join', code: code.toLowerCase() })).json()).name === 'Roommates b', 'joined (code is case-insensitive)');
ok((await (await league(ben, { action: 'league-join', code })).json()).already === true, 'joining twice is harmless');
await league(cy, { action: 'league-join', code });
ok((await get('/api/community?league=' + code, dee)).status === 403, 'non-members cannot see the board');

// Weekly XP: a first save of old progress doesn't count; later gains do
await save(ana, { learn: { xp: 0 } });
await save(ana, { learn: { xp: 120 } });
await save(ben, { learn: { xp: 500, dstreak: 4, dlast: new Date().toISOString().slice(0, 10) } });
await save(ben, { learn: { xp: 560, dstreak: 4, dlast: new Date().toISOString().slice(0, 10) } });
let d = await (await get('/api/community?league=' + code, ana)).json();
ok(d.members.map(m => `${m.name}:${m.weekXp}`).join(',') === 'Ana L.:120,Ben P.:60,Cy:0', 'board ranks this week\'s XP', d.members);
ok(!JSON.stringify(d).includes('@test.dev'), 'board shows no emails');
const benRow = d.members.find(m => m.name === 'Ben P.');
ok(benRow.level === 5 && benRow.title === 'Market Pro' && benRow.ring === 'silver' && benRow.streak === 4, 'levels, rings and streaks on the board', benRow);
ok(d.members.find(m => m.me)?.name === 'Ana L.' && d.owner === true && d.endsAt > Date.now(), 'your own row and owner flag');
let s = await (await get('/api/community?leagues=1', ben)).json();
ok(s.leagues.length === 1 && s.leagues[0].rank === 2 && s.leagues[0].weekXp === 60 && s.leagues[0].members === 3, 'your leagues summary', s);
await save(ana, { learn: { xp: 9000 } });
d = await (await get('/api/community?league=' + code, ana)).json();
ok(d.members[0].weekXp === 3000, 'weekly XP is capped', d.members[0]);

// Owner tools
ok((await league(ben, { action: 'league-rename', code, name: 'Mine now' })).status === 403, 'only the owner can rename');
ok((await (await league(ana, { action: 'league-rename', code, name: 'The Roommates' })).json()).name === 'The Roommates', 'owner renames');
const cyId = d.members.find(m => m.name === 'Cy').id;
ok((await league(ana, { action: 'league-remove', code, member: cyId })).status === 200, 'owner removes a member');
d = await (await get('/api/community?league=' + code, ana)).json();
ok(d.members.length === 2 && d.name === 'The Roommates', 'member gone, new name shown', d.members.map(m => m.name));
ok((await get('/api/community?league=' + code, cy)).status === 403, 'removed member loses access');

// Monday: last week's results are saved once and emailed to each member
await post('/__seed', { table: 'xp_weeks', rows: [
  { email: 'ana@test.dev', week: lastWeek, start_xp: 0 }, { email: 'ben@test.dev', week: lastWeek, start_xp: 100 },
] });
// Ana's this-week row already says 0 (end of last week); Ben's says 500
const before = (await dump()).mail.length;
r = await (await get('/api/send-digest?job=leagues')).json();
ok(r.ok && r.leagues.week === lastWeek && r.leagues.finalized === 1 && r.leagues.emailed === 2, 'league week finalized and emailed', r);
let mail = (await dump()).mail.slice(before);
const toBen = mail.find(m => (Array.isArray(m.to) ? m.to : [m.to]).includes('ben@test.dev'));
const toAna = mail.find(m => (Array.isArray(m.to) ? m.to : [m.to]).includes('ana@test.dev'));
ok(toBen && /You won The Roommates this week/.test(toBen.subject) && /400 XP/.test(toBen.html), 'winner email', toBen?.subject);
ok(toAna && /You finished #2 in The Roommates/.test(toAna.subject) && /Ben P\. won with 400 XP/.test(toAna.html) && /l=leagues/.test(toAna.headers?.['List-Unsubscribe'] || ''), 'runner-up email with its own unsubscribe', toAna?.subject);
r = await (await get('/api/send-digest?job=leagues')).json();
ok(r.leagues.finalized === 0 && r.leagues.emailed === 0, 'running it again sends nothing', r.leagues);
s = await (await get('/api/community?leagues=1', ben)).json();
ok(s.wins === 1 && s.leagues[0].lastWinner?.name === 'Ben P.' && s.leagues[0].lastWinner.me, 'wins and last week\'s winner in the summary', s);
const unsub = toAna.headers['List-Unsubscribe'].slice(1, -1).replace(/^https?:\/\/[^/]+/, B);
ok((await fetch(unsub, { method: 'POST' })).status === 200 && (await dump()).tables.users.find(u => u.email === 'ana@test.dev').league_emails === false, 'league emails can be turned off');

// Leaving: the owner's role passes on; an empty league is deleted
await league(ana, { action: 'league-leave', code });
d = await (await get('/api/community?league=' + code, ben)).json();
ok(d.owner === true && d.members.length === 1, 'owner left: next member runs the league', d);
await league(ben, { action: 'league-leave', code });
ok(!(await dump()).tables.leagues.some(l => l.code === code), 'empty league deleted');

// Limits
for (let i = 0; i < 10; i++) await league(dee, { action: 'league-create', name: 'League ' + i });
r = await league(dee, { action: 'league-create', name: 'One too many' });
ok(r.status === 409, 'at most 10 leagues each', r.status);

// Invite links get their own preview
const code2 = (await (await league(ana, { action: 'league-create', name: 'Study Group' })).json()).code;
const page = await (await fetch(B + '/join/' + code2)).text();
ok(/<title>Join Study Group on StockSight<\/title>/.test(page) && /<meta name="robots" content="noindex">/.test(page) && /invited you to Study Group/.test(page), 'invite link preview names the league');

// Profile photos: real images only, stored in our own storage, shown on boards
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
ok((await post('/api/user', { avatar: 'data:image/jpeg;base64,' + Buffer.from('hello world, not a photo').toString('base64') }, ana)).status === 400, 'non-image rejected');
ok((await post('/api/user', { avatar: 'https://evil.example/x.jpg' }, ana)).status === 400, 'outside links rejected');
r = await (await post('/api/user', { avatar: jpeg }, ana)).json();
ok(r.ok && /\/storage\/v1\/object\/public\/avatars\/[0-9a-f]{24}\.jpg\?v=/.test(r.avatar), 'photo stored', r);
const img = await fetch(r.avatar.replace(/^https?:\/\/[^/]+/, B));
ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg', 'photo served publicly');
await save(ana, { avatar: 'https://evil.example/x.jpg' });
ok((await dump()).tables.users.find(u => u.email === 'ana@test.dev').avatar === r.avatar, 'avatar cannot be set by a plain save');
await league(ben, { action: 'league-join', code: code2 });
d = await (await get('/api/community?league=' + code2, ben)).json();
ok(d.members.find(m => m.name === 'Ana L.')?.avatar === r.avatar && d.members.find(m => m.name === 'Ben P.').avatar === null, 'photos on the board');
r = await (await post('/api/user', { avatar: null }, ana)).json();
ok(r.ok && r.avatar === null && !Object.keys((await dump()).storage).length, 'photo removed from storage');

// Deleting an account leaves its leagues
const del = await post('/api/auth', { action: 'delete', confirm: 'DELETE', password: 'secret99' }, ben);
ok(del.status === 200, 'account deleted', del.status);
d = await (await get('/api/community?league=' + code2, ana)).json();
ok(d.members.length === 1 && d.members[0].name === 'Ana L.', 'deleted account is gone from the league', d.members);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
