// Shared Yahoo Finance helpers for /api/history, /api/stats and /api/fundamentals.
// Files starting with "_" in /api are not deployed as their own endpoints.

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const SYMBOL_RE = /^[\^A-Z0-9][A-Z0-9.\-=^]{0,19}$/;

// Daily closes from Yahoo Finance (dividend and split adjusted)
export async function fromYahoo(symbol, range = '5y') {
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div%2Csplits`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res?.timestamp?.length) continue;
      const closes = res.indicators?.adjclose?.[0]?.adjclose || res.indicators?.quote?.[0]?.close || [];
      const t = [], c = [];
      res.timestamp.forEach((ts, i) => {
        const v = closes[i];
        if (v != null && Number.isFinite(v) && v > 0) { t.push(ts); c.push(+v.toPrecision(7)); }
      });
      if (c.length < 30) continue;
      const m = res.meta || {};
      return {
        symbol: m.symbol || symbol,
        name: m.longName || m.shortName || '',
        currency: m.currency || 'USD',
        price: Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : c[c.length - 1],
        source: 'Yahoo Finance',
        t, c,
      };
    } catch {}
  }
  return null;
}

// Coinbase returns at most 300 daily candles per call, so page backwards
export async function fromCoinbase(symbol) {
  const product = symbol.replace(/-USD$/, '') + '-USD';
  const day = 86400;
  let end = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let page = 0; page < 5; page++) {
    const start = end - 299 * day;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) break;
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) break;
      rows.push(...j);
    } catch { break; }
    end = start - day;
  }
  if (rows.length < 30) return null;
  const seen = new Set();
  const sorted = rows.filter(r => !seen.has(r[0]) && seen.add(r[0])).sort((a, b) => a[0] - b[0]);
  const t = sorted.map(r => r[0]);
  const c = sorted.map(r => +Number(r[4]).toPrecision(7));
  return { symbol, name: '', currency: 'USD', price: c[c.length - 1], source: 'Coinbase', t, c };
}

export async function getDaily(symbol, range = '5y') {
  return (await fromYahoo(symbol, range)) || (symbol.endsWith('-USD') ? await fromCoinbase(symbol) : null);
}

// quoteSummary (fundamentals, analysts, earnings) needs a session cookie and "crumb" token
let _session = null;
async function getSession(force = false) {
  if (!force && _session && Date.now() - _session.at < 45 * 60000) return _session;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('No Yahoo session cookie');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('No Yahoo crumb');
  _session = { cookie, crumb, at: Date.now() };
  return _session;
}

export async function quoteSummary(symbol, modules) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sess;
    try { sess = await getSession(attempt > 0); } catch { continue; }
    let refresh = false;
    for (const host of ['query2', 'query1']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(',')}&crumb=${encodeURIComponent(sess.crumb)}`;
        const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: sess.cookie, Accept: 'application/json' } });
        if (r.status === 401 || r.status === 403) { refresh = true; break; }
        if (r.status === 404) return null;
        if (!r.ok) continue;
        const j = await r.json();
        return j?.quoteSummary?.result?.[0] || null;
      } catch {}
    }
    if (!refresh) break;
  }
  return null;
}

// Real one-minute regular-hours sessions (9:30 to 16:00 local) from the last ~2 weeks,
// shaped as 390 closes each, for the Day Trade replay
export async function intradaySessions(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const windows = [`range=5d`, `period1=${now - 13 * 86400}&period2=${now - 6 * 86400}`];
  const pages = await Promise.all(windows.map(async w => {
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${w}&interval=1m&includePrePost=false`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) continue;
        const res = (await r.json())?.chart?.result?.[0];
        if (res?.timestamp?.length) return res;
      } catch {}
    }
    return null;
  }));
  const days = new Map();
  let offset = -14400;
  pages.filter(Boolean).forEach(res => {
    offset = res.meta?.gmtoffset ?? offset;
    const q = res.indicators?.quote?.[0] || {};
    res.timestamp.forEach((ts, i) => {
      const c = q.close?.[i];
      if (c == null || !Number.isFinite(c)) return;
      const local = ts + (res.meta?.gmtoffset ?? offset);
      const day = Math.floor(local / 86400), minute = Math.floor((local % 86400) / 60) - 570;
      if (minute < 0 || minute > 389) return;
      if (!days.has(day)) days.set(day, { o: q.open?.[i] ?? c, m: new Map() });
      days.get(day).m.set(minute, c);
    });
  });
  const todayLocal = Math.floor((now + offset) / 86400);
  const sorted = [...days.entries()].sort((a, b) => a[0] - b[0]);
  const sessions = [];
  sorted.forEach(([day, d], k) => {
    if (d.m.size < 300) return;                            // half days and partial data
    if (day === todayLocal && now + offset < day * 86400 + 16 * 3600) return; // still trading
    const bars = new Array(390);
    let last = d.m.get(0) ?? d.o;
    for (let i = 0; i < 390; i++) { if (d.m.has(i)) last = d.m.get(i); bars[i] = +last.toPrecision(7); }
    const prev = k > 0 ? sorted[k - 1][1] : null;
    const prevClose = prev ? [...prev.m.entries()].sort((a, b) => b[0] - a[0])[0][1] : null;
    sessions.push({ day, open: +Number(d.o).toPrecision(7), prevClose: prevClose ? +prevClose.toPrecision(7) : bars[0], close: bars[389], bars });
  });
  return sessions;
}
