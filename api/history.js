// Daily price history used by the AI forecast model.
// GET /api/history?symbol=AAPL  (Yahoo-style symbols: ^GSPC, BTC-USD, BRK-B)
import { SYMBOL_RE, getDaily } from './_yahoo.js';

const RANGES = ['1y', '2y', '5y', '10y'];

export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || '').toUpperCase().trim();
  const range = RANGES.includes(req.query?.range) ? req.query.range : '5y';
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  const data = await getDaily(symbol, range);
  if (!data) {
    res.setHeader('Cache-Control', 's-maxage=120');
    return res.status(404).json({ error: 'No price history found' });
  }
  res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json(data);
}
