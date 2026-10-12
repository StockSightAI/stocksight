// Valuation, Stress test and Options: the DCF math and paper-trade store from app.js, then the
// endpoints behind them (options pulse, weekly history since 2000, reported free cash flow)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.env.TEST_BASE || 'http://localhost:5053';
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// Pull one top-level function out of app.js by name (it's a browser script, not a module)
const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8');
function fnSrc(name) {
  const start = app.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let i = app.indexOf('{', start), depth = 0;
  for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) break; }
  return app.slice(start, i + 1);
}

// DCF: a flat 100 a year at 10% with no growth is a perpetuity worth exactly 1000
const { dcfValue, impliedGrowth } = new Function(`${fnSrc('dcfValue')}\n${fnSrc('impliedGrowth')}\nreturn { dcfValue, impliedGrowth };`)();
const base = { fcf: 100, g1: 0, g2: 0, tg: 0, disc: 0.1, netCash: 0, shares: 1 };
let v = dcfValue(base);
ok(near(v?.perShare, 1000, 1e-6), 'flat cash flow at 10% is worth 1000', v?.perShare);
ok(v?.flows.length === 10, 'ten projected years', v?.flows.length);
ok(near(dcfValue({ ...base, netCash: 500, shares: 10 })?.perShare, 150, 1e-6), 'net cash adds to value, split over shares');
ok(dcfValue({ ...base, g1: 0.2 }).perShare > dcfValue({ ...base, g1: 0.1 }).perShare, 'more growth, more value');
ok(dcfValue({ ...base, disc: 0.12 }).perShare < v.perShare, 'higher discount rate, less value');
ok(dcfValue({ ...base, tg: 0.098 }) === null, 'refuses a discount rate barely above forever growth');
ok(dcfValue({ ...base, fcf: -5 }) === null && dcfValue({ ...base, shares: 0 }) === null, 'refuses negative cash flow or no shares');
const target = dcfValue({ ...base, g1: 0.12, g2: 0.06 }).perShare;
ok(near(impliedGrowth(base, target), 0.12, 1e-6), 'implied growth recovers the growth behind a price', impliedGrowth(base, target));
ok(impliedGrowth(base, 1e9) === null, 'no implied growth when even 150% growth falls short');

// Paper trading store: an empty {} synced from the server must read as a fresh $10,000 account
const store = {};
const getPt = new Function('localStorage', 'user', `${fnSrc('getPtPortfolio')}\nreturn getPtPortfolio;`)(
  { getItem: k => store[k] ?? null }, { email: 'a@test.dev' });
store['ss_pt_a@test.dev'] = '{}';
let pt = getPt();
ok(pt.cash === 10000 && pt.holdings && !Object.keys(pt.holdings).length, 'an empty paper account reads as a fresh start', pt);
store['ss_pt_a@test.dev'] = JSON.stringify({ cash: 120, holdings: { MSFT: { shares: 2, avgCost: 400 } }, live: 1 });
pt = getPt();
ok(pt.cash === 120 && pt.holdings.MSFT.shares === 2 && pt.live === 1, 'a real paper account reads unchanged', pt);
store['ss_pt_a@test.dev'] = 'not json';
ok(getPt().cash === 10000, 'a corrupt paper account falls back to a fresh start');

// The hype guard: a price far above its 200-day average can't lift the verdict
ok(/px \/ f\.twoHundredDayAvg > 1\.35\) s = Math\.min\(s, 50\)/.test(app), 'momentum is capped when the price is stretched');
ok(/fcfReported \?\? f\.freeCashflow, shares:/.test(app), 'the DCF starts from reported free cash flow');

// Options pulse
let r = await fetch(B + '/api/fundamentals?symbol=AAPL&options=1');
const o = r.status === 200 ? await r.json() : null;
ok(o, 'options pulse for AAPL', r.status);
if (o) {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(o.expiry) && o.days >= 5 && o.days <= 60, 'expiry about a month out, never this week', { expiry: o.expiry, days: o.days });
  ok(o.iv == null || (o.iv > 0.04 && o.iv < 5), 'implied volatility is sane', o.iv);
  ok(o.expectedMove > 0 && o.expectedMovePct > 0 && o.expectedMovePct < 1, 'expected move is positive and under 100%', { m: o.expectedMove, p: o.expectedMovePct });
  ok(o.putCallVolume == null || o.putCallVolume >= 0, 'put/call ratio', o.putCallVolume);
  ok(!o.protectivePut || (o.protectivePut.strike <= o.price && o.protectivePut.cost > 0), 'protective put is below the price and costs something', o.protectivePut);
  ok(Array.isArray(o.unusual) && o.unusual.every(u => u.volume >= 500 && u.volume > 2 * u.openInterest), 'unusual activity follows its rule', o.unusual.slice(0, 2));
}
r = await fetch(B + '/api/fundamentals?symbol=' + encodeURIComponent('A B') + '&options=1');
ok(r.status === 400, 'bad symbol rejected', r.status);
r = await fetch(B + '/api/fundamentals?symbol=BTC-USD&options=1');
ok(r.status === 404, 'no options for crypto', r.status);

// Weekly history since 2000 (past crashes)
r = await fetch(B + '/api/history?symbol=SPY&range=since2000');
const h = r.status === 200 ? await r.json() : null;
ok(h?.t?.length > 1300 && h.t.length === h.c.length, 'SPY weekly history since 2000', h?.t?.length);
if (h?.t?.length) {
  ok(h.t[0] * 1000 < Date.UTC(2000, 1, 1), 'starts in January 2000', new Date(h.t[0] * 1000).toISOString());
  const gaps = h.t.slice(1, 200).map((t, i) => (t - h.t[i]) / 86400).sort((a, b) => a - b);
  ok(gaps[gaps.length >> 1] === 7, 'weekly, not quarterly', gaps[gaps.length >> 1]);
}

// Reported free cash flow next to Yahoo's estimate
r = await fetch(B + '/api/fundamentals?symbol=MSFT');
const f = r.status === 200 ? (await r.json()).facts : null;
ok(f?.fcfReported > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.fcfAsOf || ''), 'reported free cash flow for MSFT', f && { fcf: f.fcfReported, asOf: f.fcfAsOf });
ok(f && 'freeCashflow' in f, 'Yahoo estimate still there for scoring');

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
