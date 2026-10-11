// Community search counts, kept on the server so they can't be stuffed with fake rows.
// POST { ticker }   records that someone looked up a ticker (once per person, ticker and day)
// GET  ?days=1      the most-searched real tickers (1 = today, up to 7), counted by distinct people
import { configured, fail, readBody, limited, ipOf } from './_auth.js';
import { logSearch, trending } from './_trending.js';
import { TICKER_RE } from './_symbols.js';

export default async function handler(req, res) {
  if (!configured()) return fail(res, 503, 'Unavailable');
  try {
    if (req.method === 'POST') {
      const ticker = String(readBody(req).ticker || '').toUpperCase().trim();
      if (!TICKER_RE.test(ticker)) return fail(res, 400, 'Invalid ticker');
      const ip = ipOf(req);
      if (limited('search:' + ip, 120, 3600e3)) return res.status(204).end();
      await logSearch(ticker, ip);
      return res.status(204).end();
    }
    if (req.method === 'GET') {
      const days = Math.min(7, Math.max(1, Number(req.query?.days) || 1));
      const list = await trending({ days, limit: 8 });
      res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=900');
      return res.status(200).json({ trending: list, days });
    }
    return fail(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('search:', e.message, e.detail || '');
    return fail(res, 500, 'Search counts unavailable');
  }
}
