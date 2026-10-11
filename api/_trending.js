// "Trending on StockSight": what people searched, counted so one person (or one script) can't fake it.
//  - Each search is stored with a searcher key: an HMAC of the IP address and the day, so raw IPs are
//    never stored and keys can't be linked across days. A unique index keeps one row per searcher,
//    ticker and day, however many times they search.
//  - Rankings count distinct searchers, and only list tickers that have a real market price.
import crypto from 'node:crypto';
import { db } from './_auth.js';
import { UA } from './_yahoo.js';
import { ySym, TICKER_RE } from './_symbols.js';

const DAY = 86400e3;
const secret = () => process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
const searcherKey = (ip, date) => crypto.createHmac('sha256', secret()).update(`search:${date}:${ip}`).digest('base64url').slice(0, 22);

export async function logSearch(ticker, ip, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  const row = { ticker, date, ip_hash: searcherKey(ip, date) };
  try {
    await db('searches?on_conflict=ticker,date,ip_hash', { method: 'POST', body: row, prefer: 'resolution=ignore-duplicates,return=minimal' });
  } catch (e) {
    // Before the ip_hash column / unique index exist, store the plain row like before
    if (e.status === 400) await db('searches', { method: 'POST', body: { ticker, date }, prefer: 'return=minimal' });
    else throw e;
  }
}

async function priced(tickers) {
  const bySym = Object.fromEntries(tickers.map(t => [ySym(t), t]));
  const out = new Set();
  const syms = Object.keys(bySym);
  for (let i = 0; i < syms.length; i += 20) {
    const chunk = syms.slice(i, i + 20);
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=5d&interval=1d`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) continue;
        const j = await r.json();
        for (const [s, q] of Object.entries(j || {})) if (bySym[s] && (q?.close || []).some(Number.isFinite)) out.add(bySym[s]);
        break;
      } catch {}
    }
  }
  return out;
}

// Most-searched real tickers over the last `days` days (1 = today, UTC), by distinct searchers
export async function trending({ days = 1, limit = 8, minPeople = 1, now = Date.now() } = {}) {
  const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
  let rows;
  try { rows = await db(`searches?select=ticker,ip_hash&date=gte.${since}&limit=50000`); }
  catch { rows = await db(`searches?select=ticker&date=gte.${since}&limit=50000`).catch(() => []); }
  const people = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const t = String(r?.ticker || '').toUpperCase();
    if (!TICKER_RE.test(t)) return;
    if (!people.has(t)) people.set(t, new Set());
    people.get(t).add(r.ip_hash || `row${i}`); // rows from before searcher keys each count once
  });
  const ranked = [...people].map(([t, s]) => ({ ticker: t, people: s.size })).filter(x => x.people >= minPeople)
    .sort((a, b) => b.people - a.people || a.ticker.localeCompare(b.ticker)).slice(0, limit * 2 + 4);
  if (!ranked.length) return [];
  const real = await priced(ranked.map(x => x.ticker));
  return ranked.filter(x => real.has(x.ticker)).slice(0, limit);
}
