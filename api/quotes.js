// Latest prices for a list of symbols (portfolio P&L, forecast headline).
// GET /api/quotes?symbols=AAPL,BTC-USD,^GSPC  (Yahoo-style symbols, max 40)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SYMBOL_RE = /^[\^A-Z0-9][A-Z0-9.\-=^]{0,19}$/;

async function spark(symbols) {
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=1d&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) continue;
      return await r.json();
    } catch {}
  }
  return {};
}

export default async function handler(req, res) {
  const symbols = [...new Set(String(req.query?.symbols || '').toUpperCase().split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)))].slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });

  const quotes = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const data = await spark(symbols.slice(i, i + 20));
    for (const [sym, q] of Object.entries(data || {})) {
      const price = q?.close?.[q.close.length - 1] ?? q?.fulldayPrice;
      if (!Number.isFinite(price)) continue;
      const prev = Number.isFinite(q.chartPreviousClose) ? q.chartPreviousClose : null;
      quotes[sym] = {
        price,
        prevClose: prev,
        change: prev ? +(price - prev).toPrecision(6) : null,
        changePct: prev ? +((price / prev - 1) * 100).toFixed(3) : null,
        time: q.timestamp?.[q.timestamp.length - 1] || null,
      };
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ quotes });
}
