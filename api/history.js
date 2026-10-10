// Daily price history used by the AI forecast model.
// GET /api/history?symbol=AAPL  (Yahoo-style symbols: ^GSPC, BTC-USD, BRK-B)
// GET /api/history?symbol=AAPL&intraday=1  real one-minute sessions for the Day Trade replay
import { SYMBOL_RE, getDaily, intradaySessions } from './_yahoo.js';

const RANGES = ['1y', '2y', '5y', '10y'];

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || '').toUpperCase().trim();
  const range = RANGES.includes(req.query?.range) ? req.query.range : '5y';
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  if (req.query?.intraday) {
    const sessions = await intradaySessions(symbol).catch(() => []);
    res.setHeader('Cache-Control', sessions.length ? 'public, max-age=900, s-maxage=3600, stale-while-revalidate=21600' : 's-maxage=120');
    return res.status(sessions.length ? 200 : 404).json({ symbol, sessions });
  }

  const data = await getDaily(symbol, range);
  if (!data) {
    res.setHeader('Cache-Control', 's-maxage=120');
    return res.status(404).json({ error: 'No price history found' });
  }
  res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(data);
}
