// Risk and growth numbers computed from real daily prices, for the screener and stock pages.
// GET /api/stats?symbols=AAPL,BTC-USD,^GSPC  (Yahoo-style symbols, max 25)
//
// vol    yearly volatility: standard deviation of the last year of daily returns, annualised
// beta   sensitivity to the S&P 500 from 2 years of weekly returns, Bloomberg-style adjusted
//        toward 1 (0.67 x raw + 0.33) so one odd year does not swing it (corr is the correlation)
// cagr   average yearly growth over up to 5 years (years says how many were available)
// ret1y  price change over the last year
// rsi    14-day RSI (Wilder)
// maxDD  biggest fall from a peak over the last year
import { SYMBOL_RE, getDaily } from './_yahoo.js';

const day = ts => Math.floor(ts / 86400);

function rsi14(c) {
  const n = c.length;
  if (n < 40) return null;
  const st = Math.max(1, n - 151);
  let g = 0, l = 0;
  for (let i = st; i < st + 14; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= 14; l /= 14;
  for (let i = st + 14; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function compute(h, mkt, isMarket) {
  const { c, t } = h, n = c.length;
  const crypto = h.symbol.endsWith('-USD') || h.source === 'Coinbase';
  const ppy = crypto ? 365 : 252;
  const yr = Math.min(n - 1, ppy);

  // Volatility over the last year
  let s = 0, s2 = 0;
  for (let i = n - yr; i < n; i++) { const r = Math.log(c[i] / c[i - 1]); s += r; s2 += r * r; }
  const mean = s / yr, vol = Math.sqrt(Math.max(0, s2 / yr - mean * mean) * ppy);

  // Growth
  const span = (t[n - 1] - t[0]) / 31557600;
  const years = Math.min(5, span);
  let start = 0;
  const target = t[n - 1] - years * 31557600;
  while (start < n - 1 && t[start] < target) start++;
  const yrsUsed = (t[n - 1] - t[start]) / 31557600;
  const cagr = yrsUsed >= 0.9 ? Math.pow(c[n - 1] / c[start], 1 / yrsUsed) - 1 : null;
  const ret1y = c[n - 1] / c[n - 1 - yr] - 1;

  // Biggest drop from a peak in the last year
  let peak = 0, maxDD = 0;
  for (let i = n - 1 - yr; i < n; i++) { peak = Math.max(peak, c[i]); maxDD = Math.min(maxDD, c[i] / peak - 1); }

  // Beta from weekly returns over 2 years, matched day by day with the S&P 500
  let beta = isMarket ? 1 : null, corr = isMarket ? 1 : null;
  if (mkt && !isMarket) {
    const m = new Map(mkt.t.map((ts, i) => [day(ts), mkt.c[i]]));
    const pairs = [];
    for (let i = 0; i < n; i++) { const mc = m.get(day(t[i])); if (mc != null) pairs.push([c[i], mc]); }
    const recent = pairs.slice(-505);
    const xs = [], ys = [];
    for (let i = recent.length - 1; i - 5 >= 0; i -= 5) {
      ys.push(Math.log(recent[i][0] / recent[i - 5][0]));
      xs.push(Math.log(recent[i][1] / recent[i - 5][1]));
    }
    if (xs.length >= 26) {
      const k = xs.length, mx = xs.reduce((a, b) => a + b, 0) / k, my = ys.reduce((a, b) => a + b, 0) / k;
      let cov = 0, vx = 0, vy = 0;
      for (let i = 0; i < k; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
      if (vx > 0) { beta = 0.67 * (cov / vx) + 0.33; corr = vy > 0 ? cov / Math.sqrt(vx * vy) : null; }
    }
  }

  const rsi = rsi14(c);
  const round = (v, d) => v == null || !Number.isFinite(v) ? null : +v.toFixed(d);
  return {
    price: round(h.price, 6),
    vol: round(vol, 4),
    beta: round(beta, 3),
    corr: round(corr, 3),
    cagr: round(cagr, 4),
    years: round(yrsUsed, 2),
    ret1y: round(ret1y, 4),
    rsi: round(rsi, 1),
    maxDD: round(maxDD, 4),
    asOf: t[n - 1],
  };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export default async function handler(req, res) {
  const symbols = [...new Set(String(req.query?.symbols || '').toUpperCase().split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)))].slice(0, 25);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });

  const mkt = await getDaily('^GSPC');
  const hists = await pool(symbols, 6, s => s === '^GSPC' ? Promise.resolve(mkt) : getDaily(s).catch(() => null));
  const stats = {};
  symbols.forEach((s, i) => {
    const h = hists[i];
    if (!h || h.c.length < 60) return;
    try { stats[s] = compute(h, mkt, s === '^GSPC'); } catch {}
  });
  res.setHeader('Cache-Control', Object.keys(stats).length
    ? 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400'
    : 's-maxage=120');
  return res.status(200).json({ stats });
}
