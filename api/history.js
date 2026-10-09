// Daily price history used by the AI forecast model.
// Yahoo Finance chart API first, Coinbase candles as a fallback for crypto.
// GET /api/history?symbol=AAPL  (Yahoo-style symbols: ^GSPC, BTC-USD, BRK-B)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SYMBOL_RE = /^[\^A-Z0-9][A-Z0-9.\-=^]{0,19}$/;
const RANGES = ['1y', '2y', '5y', '10y'];

async function fromYahoo(symbol, range) {
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
        prevClose: Number.isFinite(m.chartPreviousClose) ? m.chartPreviousClose : null,
        source: 'Yahoo Finance',
        t, c,
      };
    } catch {}
  }
  return null;
}

// Coinbase returns at most 300 daily candles per call, so page backwards
async function fromCoinbase(symbol) {
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
  return { symbol, name: '', currency: 'USD', price: c[c.length - 1], prevClose: c[c.length - 2] || null, source: 'Coinbase', t, c };
}

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || '').toUpperCase().trim();
  const range = RANGES.includes(req.query?.range) ? req.query.range : '5y';
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  let data = await fromYahoo(symbol, range);
  if (!data && symbol.endsWith('-USD')) data = await fromCoinbase(symbol);
  if (!data) {
    res.setHeader('Cache-Control', 's-maxage=120');
    return res.status(404).json({ error: 'No price history found' });
  }
  res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(data);
}
