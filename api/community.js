// Community data, kept on the server so it can't be stuffed from the browser.
//   POST { action: 'search', ticker }        someone looked up a ticker (once per person, ticker and day)
//   POST { action: 'vote', ticker, vote }    buy / hold / sell; needs the sign-in token, one vote per account
//   POST { action: 'error', message, ... }   a crash in someone's browser, kept for the daily error summary
//   GET  ?trending=1&days=1                  the most-searched real tickers (1 = today, up to 7)
//   GET  ?votes=TICKER                       vote counts, plus your own vote when signed in
import crypto from 'node:crypto';
import { configured, fail, readBody, limited, ipOf, db, sessionRow, readSession } from './_auth.js';
import { logSearch, trending } from './_trending.js';
import { TICKER_RE } from './_symbols.js';

const VOTES = ['buy', 'hold', 'sell'];
// Same id the site used before votes moved here, so existing votes stay with their owners
const voterId = email => crypto.createHash('sha256').update('stocksight-vote:' + String(email).trim().toLowerCase()).digest('hex');

async function voteCounts(ticker) {
  const rows = await db(`votes?ticker=eq.${encodeURIComponent(ticker)}&select=vote&limit=100000`);
  const c = { buy: 0, hold: 0, sell: 0 };
  for (const r of Array.isArray(rows) ? rows : []) if (c[r.vote] != null) c[r.vote]++;
  return { ...c, total: c.buy + c.hold + c.sell };
}

export default async function handler(req, res) {
  if (!configured()) return fail(res, 503, 'Unavailable');
  try {
    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'error') {
        // Small, capped and best effort: the table may not exist yet, and reports never fail the page
        if (limited('err:' + ipOf(req), 20, 3600e3)) return res.status(204).end();
        const clip = (v, n) => String(v ?? '').slice(0, n);
        const row = { message: clip(b.message, 500), source: clip(b.source, 300), stack: clip(b.stack, 2000), page: clip(b.page, 200), ua: clip(req.headers?.['user-agent'], 200) };
        if (row.message) await db('client_errors', { method: 'POST', body: row, prefer: 'return=minimal' }).catch(() => {});
        return res.status(204).end();
      }

      const ticker = String(b.ticker || '').toUpperCase().trim();
      if (!TICKER_RE.test(ticker)) return fail(res, 400, 'Invalid ticker');

      if (b.action === 'vote') {
        if (!VOTES.includes(b.vote)) return fail(res, 400, 'Invalid vote');
        const row = await sessionRow(req);
        if (!row) return fail(res, 401, 'Sign in to vote');
        if (limited('vote:' + row.email, 40, 600e3)) return fail(res, 429, 'Too many votes. Try again in a few minutes.');
        await db('votes?on_conflict=ticker,voter_hash', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
          body: { ticker, voter_hash: voterId(row.email), vote: b.vote },
        });
        return res.status(200).json({ ok: true, ...(await voteCounts(ticker)), mine: b.vote });
      }

      // A search (the default action)
      const ip = ipOf(req);
      if (limited('search:' + ip, 120, 3600e3)) return res.status(204).end();
      await logSearch(ticker, ip);
      return res.status(204).end();
    }

    if (req.method === 'GET') {
      if (req.query?.votes) {
        const ticker = String(req.query.votes).toUpperCase().trim();
        if (!TICKER_RE.test(ticker)) return fail(res, 400, 'Invalid ticker');
        const counts = await voteCounts(ticker);
        // Your own vote, if you're signed in (a valid signature is enough to read it)
        const s = readSession(req);
        let mine = null;
        if (s) {
          const r = await db(`votes?ticker=eq.${encodeURIComponent(ticker)}&voter_hash=eq.${voterId(s.email)}&select=vote&limit=1`);
          mine = Array.isArray(r) && r[0] ? r[0].vote : null;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({ ticker, ...counts, mine });
      }
      const days = Math.min(7, Math.max(1, Number(req.query?.days) || 1));
      const list = await trending({ days, limit: 8 });
      res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=900');
      return res.status(200).json({ trending: list, days });
    }
    return fail(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('community:', e.message, e.detail || '');
    return fail(res, 500, 'Community data unavailable');
  }
}
