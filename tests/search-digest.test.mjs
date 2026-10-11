// Search logging and trending (api/community.js), the weekly digest and its owner report (api/send-digest.js)
const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const post = (ticker, ip) => fetch(B + '/api/community', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ action: 'search', ticker }) });
const dump = async () => (await fetch(B + '/__db')).json();
const anon = (path, init = {}) => fetch(B + '/fakesb/rest/v1/' + path, { ...init, headers: { apikey: 'sb_publishable_x', 'Content-Type': 'application/json', ...(init.headers || {}) } });

// logging
let r = await post('msft', '1.1.1.1');
ok(r.status === 204, 'log search 204', r.status);
r = await post("');alert(1)//", '1.1.1.1');
ok(r.status === 400, 'injection ticker rejected', r.status);
r = await post('A'.repeat(30), '1.1.1.1');
ok(r.status === 400, 'long ticker rejected', r.status);
for (let i = 0; i < 25; i++) await post('MSFT', '1.1.1.1');
let d = await dump();
let msft = d.tables.searches.filter(x => x.ticker === 'MSFT');
ok(msft.length === 1 && msft[0].ip_hash && !msft[0].ip_hash.includes('1.1.1.1'), 'same person counted once, IP not stored', msft);
await post('MSFT', '2.2.2.2'); await post('MSFT', '3.3.3.3');
d = await dump();
ok(d.tables.searches.filter(x => x.ticker === 'MSFT').length === 3, 'three people = three rows');
ok((await anon('searches', { method: 'POST', body: JSON.stringify({ ticker: 'SPAM', date: '2026-10-10' }) })).status === 401, 'anon insert blocked (after lockdown)');

// trending
r = await (await fetch(B + '/api/community?trending=1&days=1')).json();
const list = r.trending.map(x => x.ticker);
console.log('trending today:', JSON.stringify(r.trending));
ok(list[0] === 'AAPL', 'AAPL first (4 people)', list);
ok(!list.includes('ZZQXW'), 'fake ticker with no price left out', list);
ok(!list.some(t => t.includes("'")), 'injection never listed', list);
const sofi = r.trending.find(x => x.ticker === 'SOFI');
ok(!sofi || sofi.people === 1, '60 searches from one spammer = 1 person', sofi);
ok(list.indexOf('SOFI') === -1 || list.indexOf('SOFI') > list.indexOf('PLTR'), 'spammer ranks below real interest', list);
ok(r.trending.find(x => x.ticker === 'MSFT')?.people === 3, 'MSFT 3 people', r.trending);

// digest: trending needs 2+ people; report goes to the owner
await fetch(B + '/__yahoo?down=0');
r = await (await fetch(B + '/api/send-digest')).json();
ok(r.ok && r.sent === r.total && r.sent > 0, 'digest sent', r);
d = await dump();
const report = d.mail.filter(m => (Array.isArray(m.to) ? m.to : [m.to]).includes('owner@test.dev'));
ok(report.length === 1, 'one owner report', report.length);
const rep = report[0] || {};
console.log('report subject:', rep.subject);
ok(/\[StockSight\] Digest sent to all \d+ subscriber/.test(rep.subject || ''), 'report subject', rep.subject);
ok(/Scoreboard/.test(rep.html) && /Pick of the week/.test(rep.html) && /Trending/.test(rep.html), 'report has section health');
const digestMail = d.mail.find(m => Array.isArray(m.to) && m.to[0] === 'bare@test.dev');
const trendingInEmail = (digestMail?.html.match(/\?stock=([A-Z.]+)" style="[^"]*background:#efecff;border-radius:999px/g) || []).map(x => x.match(/stock=([A-Z.]+)/)[1]);
console.log('trending in email:', trendingInEmail.join(','));
ok(!trendingInEmail.includes('SOFI') && !trendingInEmail.includes('HOOD') && !trendingInEmail.includes('ZZQXW'), 'email trending: no spam, no 1-person, no fake', trendingInEmail);
ok(trendingInEmail.includes('AAPL') && trendingInEmail.includes('NVDA'), 'email trending has real ones', trendingInEmail);

// tests and previews never send a report
const before = (await dump()).mail.length;
await fetch(B + '/api/send-digest?to=bare@test.dev');
await fetch(B + '/api/send-digest?preview=1');
d = await dump();
const newMail = d.mail.slice(before);
ok(newMail.length === 1 && newMail[0].to?.[0] === 'bare@test.dev', 'test send: just the test email, no report', newMail.map(m => m.to));

// failure report when market data is down
await fetch(B + '/__yahoo?down=1');
r = await fetch(B + '/api/send-digest');
ok(r.status === 503, 'yahoo down -> 503, nothing sent', r.status);
d = await dump();
const fail = d.mail.slice(-1)[0];
ok(/NOT sent: market data unavailable/.test(fail?.subject || '') && (Array.isArray(fail.to) ? fail.to : [fail.to]).includes('owner@test.dev'), 'failure report sent', fail?.subject);
await fetch(B + '/__yahoo?down=0');

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
