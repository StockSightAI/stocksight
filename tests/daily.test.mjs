// The daily job (price-alert emails and the site error summary), alert unsubscribes,
// /stock/ pages and the app manifest
const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const json = (path, body, tok) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
const dump = async () => (await fetch(B + '/__db')).json();
const row = async email => (await dump()).tables.users.find(u => u.email === email);
const signup = async (email, name) => (await (await json('/api/auth', { action: 'signup', name, email, password: 'secret99' })).json()).token;
const save = (tok, patch) => json('/api/user', { patch }, tok);

// Three people with alerts
const alice = await signup('alice@test.dev', 'Alice'), bob = await signup('bob@test.dev', 'Bob'), carol = await signup('carol@test.dev', 'Carol');
await save(alice, { alerts: [
  { ticker: 'AAPL', targetPrice: 1, direction: 'above', fired: false },          // crossed: email
  { ticker: 'MSFT', targetPrice: 1e9, direction: 'below', fired: false },        // crossed: email
  { ticker: 'NVDA', targetPrice: 5, direction: 'above', fired: true },           // already fired: ignored
  { ticker: 'TSLA', targetPrice: 1e9, direction: 'above', fired: false },        // not crossed
] });
await save(bob, { alerts: { TSLA: 1000000 } });                                   // the old format, no direction
await save(carol, { alerts: [{ ticker: 'AAPL', targetPrice: 1, direction: 'above', fired: false }], alert_emails: false });
ok((await row('carol@test.dev')).alert_emails === false, 'alert_emails is a setting users can change');

// Error reports from browsers
for (const m of ['TypeError: x is undefined', 'TypeError: x is undefined', 'ReferenceError: foo is not defined']) {
  const r = await json('/api/community', { action: 'error', message: m, source: 'https://stocksightai.com/app.js:10:5', page: '/stock/AAPL' });
  ok(r.status === 204, 'error report accepted', r.status);
}
ok((await dump()).tables.client_errors?.length === 3, 'error reports stored');

// The daily job
let r = await (await fetch(B + '/api/send-digest?job=alerts')).json();
ok(r.ok && r.alerts.fired === 3 && r.alerts.directed === 1 && r.alerts.emailed === 1, 'alerts: 3 fired, 1 got a direction, 1 email', r);
ok(r.errors.errors === 3 && r.errors.groups === 2, 'error summary: 3 reports in 2 groups', r.errors);
let d = await dump();
const toAlice = d.mail.filter(m => (Array.isArray(m.to) ? m.to : [m.to]).includes('alice@test.dev'));
ok(toAlice.length === 1 && /2 of your price alerts were hit/.test(toAlice[0].subject), 'one email to Alice for both alerts', toAlice.map(m => m.subject));
ok(/AAPL/.test(toAlice[0]?.html) && /MSFT/.test(toAlice[0]?.html) && !/NVDA|TSLA/.test(toAlice[0]?.html), 'email lists only the crossed alerts');
ok(/\/stock\/AAPL/.test(toAlice[0]?.html) && /l=alerts/.test(toAlice[0]?.headers?.['List-Unsubscribe'] || ''), 'stock links and an alerts unsubscribe header');
ok(!d.mail.some(m => (Array.isArray(m.to) ? m.to : [m.to]).some(t => /bob|carol/.test(t))), 'no email to Bob (no cross) or Carol (emails off)');
const owner = d.mail.find(m => (Array.isArray(m.to) ? m.to : [m.to]).includes('owner@test.dev') && /site error report/.test(m.subject));
ok(owner && /x is undefined/.test(owner.html) && /2×/.test(owner.html), 'owner gets the error summary', owner?.subject);
const aliceAlerts = (await row('alice@test.dev')).alerts;
ok(aliceAlerts.find(a => a.ticker === 'AAPL').fired && aliceAlerts.find(a => a.ticker === 'AAPL').emailedAt && !aliceAlerts.find(a => a.ticker === 'TSLA').fired, 'Alice\'s crossed alerts marked fired', aliceAlerts);
const bobAlerts = (await row('bob@test.dev')).alerts;
ok(Array.isArray(bobAlerts) && bobAlerts[0].direction === 'above' && !bobAlerts[0].fired, 'Bob\'s old alert converted and given a direction', bobAlerts);
const carolAlerts = (await row('carol@test.dev')).alerts;
ok(carolAlerts[0].fired && !carolAlerts[0].emailedAt, 'Carol\'s alert fired without an email', carolAlerts);

// Running it twice sends nothing new
const before = (await dump()).mail.length;
r = await (await fetch(B + '/api/send-digest?job=alerts')).json();
ok(r.alerts.emailed === 0 && r.alerts.fired === 0, 'second run: nothing new', r.alerts);
ok((await dump()).mail.length === before + 1, 'second run: only the error summary again', (await dump()).mail.length - before);

// Unsubscribing from alert emails leaves the weekly digest alone
const unsub = toAlice[0].headers['List-Unsubscribe'].slice(1, -1).replace(/^https?:\/\/[^/]+/, B);
await json('/api/user', { patch: { digest: true } }, alice);
ok((await fetch(unsub)).status === 200, 'alerts unsubscribe page');
ok((await fetch(unsub, { method: 'POST' })).status === 200, 'alerts unsubscribe');
let a = await row('alice@test.dev');
ok(a.alert_emails === false && a.digest === true, 'only alert emails turned off', { alert_emails: a.alert_emails, digest: a.digest });
ok((await fetch(unsub.replace('&l=alerts', ''), { method: 'POST' })).status === 400, 'an alerts link can\'t unsubscribe from the digest');

// Stock pages
let p = await fetch(B + '/stock/AAPL');
let html = await p.text();
ok(p.status === 200 && /<title>Apple[^<]*\(AAPL\)[^<]*\| StockSight<\/title>/.test(html), 'stock page title', html.match(/<title>[^<]*/)?.[0]);
ok(html.includes('<link rel="canonical" href="https://stocksightai.com/stock/AAPL">') && html.includes('content="https://stocksightai.com/stock/AAPL"'), 'canonical and og:url point at the stock page');
ok(/<meta name="description" content="Apple[^"]*trading at \$/.test(html), 'description has the real price', html.match(/<meta name="description" content="[^"]*/)?.[0]);
ok(/id="seoStock"/.test(html) && /StockSight verdict/.test(html) && /<script defer src="\/app\.js">/.test(html), 'summary for crawlers, app still loads');
p = await fetch(B + '/stock/ZZQXWV');
html = await p.text();
ok(p.status === 404 && /<meta name="robots" content="noindex">/.test(html), 'unknown ticker: 404, not indexed', p.status);
p = await fetch(B + '/stock/BTC');
ok(p.status === 200 && /\(BTC\)/.test(await p.text()), 'crypto stock page');

// Installable app
const man = await (await fetch(B + '/manifest.webmanifest')).json();
ok(man.display === 'standalone' && man.icons.some(i => i.sizes === '512x512') && man.icons.some(i => i.purpose === 'maskable'), 'manifest has standalone display and icons', man);
for (const i of man.icons) ok((await fetch(B + i.src)).status === 200, `icon ${i.src} exists`);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
