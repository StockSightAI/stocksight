// Market-wide readings for the Markets page, all from live public sources.
// GET /api/market  ->  { fearGreed, cryptoFearGreed, econ }
//
// fearGreed        CNN Business Fear & Greed Index (0-100). If CNN can't be reached we
//                  compute a stand-in from S&P 500 momentum, VIX and 52-week position.
// cryptoFearGreed  alternative.me Crypto Fear & Greed Index
// econ             this week's and next week's scheduled economic releases (Forex Factory feed)
import { UA, getDaily } from './_yahoo.js';

const rating = s => s < 25 ? 'Extreme fear' : s < 45 ? 'Fear' : s <= 55 ? 'Neutral' : s <= 75 ? 'Greed' : 'Extreme greed';

async function cnn() {
  const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: { 'User-Agent': UA, Referer: 'https://www.cnn.com/', Origin: 'https://www.cnn.com', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const fg = j?.fear_and_greed;
  if (!fg || typeof fg.score !== 'number') return null;
  const hist = (j.fear_and_greed_historical?.data || []).slice(-60).map(p => ({ t: p.x, v: Math.round(p.y) }));
  return {
    score: Math.round(fg.score), rating: fg.rating ? fg.rating.replace(/^./, c => c.toUpperCase()) : rating(fg.score),
    previousClose: Math.round(fg.previous_close), weekAgo: Math.round(fg.previous_1_week),
    monthAgo: Math.round(fg.previous_1_month), yearAgo: Math.round(fg.previous_1_year),
    history: hist, source: 'CNN Business', asOf: fg.timestamp,
  };
}

// Stand-in: where today sits within the past year on three of CNN's own ingredients
async function computed() {
  const [spx, vix] = await Promise.all([getDaily('^GSPC', '2y'), getDaily('^VIX', '2y')]);
  if (!spx || !vix) return null;
  const pct = (arr, v) => arr.filter(x => x <= v).length / arr.length * 100;
  const c = spx.c, n = c.length, sma = (a, i, k) => a.slice(i - k + 1, i + 1).reduce((s, x) => s + x, 0) / k;
  const mom = [], pos = [];
  for (let i = n - 252; i < n; i++) {
    mom.push(c[i] / sma(c, i, 125) - 1);
    const win = c.slice(i - 251, i + 1), hi = Math.max(...win), lo = Math.min(...win);
    pos.push((c[i] - lo) / (hi - lo || 1));
  }
  const v = vix.c, m = v.length, vr = [];
  for (let i = m - 252; i < m; i++) vr.push(v[i] / sma(v, i, 50) - 1);
  const score = Math.round((pct(mom, mom[mom.length - 1]) + pct(pos, pos[pos.length - 1]) + (100 - pct(vr, vr[vr.length - 1]))) / 3);
  return { score, rating: rating(score), source: 'StockSight estimate from S&P 500 momentum, VIX and 52-week range', asOf: new Date().toISOString() };
}

async function crypto() {
  const r = await fetch('https://api.alternative.me/fng/?limit=8', { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const j = await r.json();
  const d = j?.data;
  if (!Array.isArray(d) || !d.length) return null;
  const v = x => Number(x?.value);
  return { score: v(d[0]), rating: d[0].value_classification, yesterday: v(d[1]), weekAgo: v(d[7]) || null, source: 'alternative.me', asOf: Number(d[0].timestamp) * 1000 };
}

async function econ() {
  const weeks = await Promise.all(['thisweek', 'nextweek'].map(async w => {
    try {
      const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${w}.json`, { headers: { 'User-Agent': UA } });
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }));
  return weeks.flat()
    .filter(e => e && e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
    .map(e => ({ title: e.title, date: e.date, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null, actual: e.actual || null }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

export default async function handler(req, res) {
  const [fg, cfg, ev] = await Promise.all([
    cnn().catch(() => null).then(x => x || computed().catch(() => null)),
    crypto().catch(() => null),
    econ().catch(() => []),
  ]);
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=1800, stale-while-revalidate=7200');
  return res.status(200).json({ fearGreed: fg, cryptoFearGreed: cfg, econ: ev });
}
